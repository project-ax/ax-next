import { acceptHistoricalDispatch } from './support/historical-dispatch.js';
import { describe, it, expect } from 'vitest';
import { CompiledQuery, sql } from 'kysely';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import { RoutineDefinitionSchema, type RoutineDefinition, type RoutineTasksForConversationsOutput } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { tasksForConversationsQuery } from '../store.js';
import { registerRoutineServices } from '../services.js';

// TASK-932: which conversations are check-ins of the caller's own tasks, so
// Today can name the task an approval was held in. The store reads at most two
// runs per conversation; the hook runs agents:resolve first.
const f = fixture();

const TASK = {
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
} as const;
const taskDefinition = (name = 'Support queue') => RoutineDefinitionSchema.parse({ ...TASK, name });
type Key = { agentId: string; routineId: string; revision: string };
const create = (requestId: string, definition: RoutineDefinition, over: { agentId?: string; ownerUserId?: string } = {}) =>
  f.store.createAuthored({ ...createInput(requestId), ...over, definition });
/** One run of `row`, bound to `conversationId` and left open. */
const run = async (row: Key, requestId: string, conversationId: string) => {
  const { accepted } = (await acceptHistoricalDispatch(f.db,f.store,{
    agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', source: 'manual', requestId, now,
  }))!;
  await f.store.bindDispatchConversation({ dispatchId: accepted.dispatchId, conversationId });
  return accepted;
};
// The fire row records another conversation, so only the run's own binding can name its check-in.
const finish = (dispatchId: string) => f.store.finishDispatch({
  dispatchId, outcome: { status: 'ok', conversationId: 'c', error: null, renderedPrompt: 'ran', warning: null },
});
const ask = async (conversationIds: readonly string[], actorUserId = 'owner', agentId = 'a') =>
  (await f.store.tasksForConversations({ agentId, actorUserId, conversationIds }))
    .sort((x, y) => x.conversationId.localeCompare(y.conversationId));
const drop = (row: Key) => f.store.deleteAuthored({
  agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: `delete-${row.routineId}`, actorUserId: 'owner', now,
});

describe('tasksForConversations (store, TASK-932)', () => {
  it("names a check-in's conversation while its run is open and after it finishes", async () => {
    const task = await create('task', taskDefinition());
    const done = await run(task, 'done', 'c-done');
    expect(await finish(done.dispatchId)).toBe(true);
    await run(task, 'open', 'c-open');
    const named = { routineId: task.routineId, name: 'Support queue' };
    expect(await ask(['c-open', 'c-done'])).toStrictEqual([{ conversationId: 'c-done', ...named }, { conversationId: 'c-open', ...named }]);
  });

  it("leaves out a repeat routine, another person's task, another agent's task, a deleted task and a conversation no run is bound to", async () => {
    await run(await create('repeat', createInput('repeat').definition), 'repeat', 'c-repeat');
    const theirs = await create('theirs', taskDefinition('Their queue'), { ownerUserId: 'someone-else' });
    await run(theirs, 'theirs', 'c-theirs');
    const elsewhere = await create('elsewhere', taskDefinition('Other agent'), { agentId: 'b' });
    await run(elsewhere, 'elsewhere', 'c-elsewhere');
    const gone = await create('gone', taskDefinition('Gone'));
    await run(gone, 'gone', 'c-gone');
    await drop(gone);
    expect(await ask(['c-repeat', 'c-theirs', 'c-elsewhere', 'c-gone', 'c-none'])).toStrictEqual([]);
    // Each is named to the person it belongs to, on its own agent.
    expect(await ask(['c-theirs'], 'someone-else')).toStrictEqual([{ conversationId: 'c-theirs', routineId: theirs.routineId, name: 'Their queue' }]);
    expect(await ask(['c-elsewhere'], 'owner', 'b')).toStrictEqual([{ conversationId: 'c-elsewhere', routineId: elsewhere.routineId, name: 'Other agent' }]);
  });

  it('leaves out a conversation that more than one run shares, whichever routines they belong to', async () => {
    const task = await create('task', taskDefinition());
    // Historical overlapping runs still make a conversation ambiguous after upgrade/rollback.
    await run(task, 'first', 'c-shared');
    expect(await finish((await run(task, 'second', 'c-shared')).dispatchId)).toBe(true);
    // The runs are counted before any filter: another person's task, a repeat routine and a deleted
    // routine each make a conversation ambiguous, though none of them could be named.
    const theirs = await create('theirs', taskDefinition('Their queue'), { ownerUserId: 'someone-else' });
    await run(task, 'mixed-mine', 'c-mixed');
    await run(theirs, 'mixed-theirs', 'c-mixed');
    const repeat = await create('repeat', createInput('repeat').definition);
    await run(task, 'with-repeat-task', 'c-with-repeat');
    await run(repeat, 'with-repeat-repeat', 'c-with-repeat');
    const dropped = await create('dropped', taskDefinition('Dropped'));
    await run(task, 'with-gone-task', 'c-with-gone');
    await run(dropped, 'with-gone-dropped', 'c-with-gone');
    await drop(dropped);
    expect(await ask(['c-shared', 'c-mixed', 'c-with-repeat', 'c-with-gone'])).toStrictEqual([]);
  });

  it('still names a check-in whose definition no longer parses', async () => {
    const task = await create('task', taskDefinition());
    await run(task, 'run', 'c1');
    // A task with no going-well-when fails every `rowToRoutine` read.
    await sql`UPDATE routines_v1_definitions SET good_when = NULL WHERE routine_id = ${task.routineId}`.execute(f.db);
    await expect(f.store.findOne({ agentId: 'a', routineId: task.routineId })).rejects.toThrow();
    expect(await ask(['c1'])).toStrictEqual([{ conversationId: 'c1', routineId: task.routineId, name: 'Support queue' }]);
  });

  it('leaves out only the conversation whose task name the contract refuses', async () => {
    const kept = await create('kept', taskDefinition());
    const blank = await create('blank', taskDefinition('Blank'));
    const long = await create('long', taskDefinition('Long'));
    await run(kept, 'kept', 'c-kept');
    await run(blank, 'blank', 'c-blank');
    await run(long, 'long', 'c-long');
    await sql`UPDATE routines_v1_definitions SET name = '' WHERE routine_id = ${blank.routineId}`.execute(f.db);
    await sql`UPDATE routines_v1_definitions SET name = ${'x'.repeat(129)} WHERE routine_id = ${long.routineId}`.execute(f.db);
    expect(await ask(['c-kept', 'c-blank', 'c-long'])).toStrictEqual([{ conversationId: 'c-kept', routineId: kept.routineId, name: 'Support queue' }]);
  });

  it('answers a repeated id once', async () => {
    const task = await create('task', taskDefinition());
    await run(task, 'run', 'c1');
    expect(await f.store.tasksForConversations({ agentId: 'a', actorUserId: 'owner', conversationIds: ['c1', 'c1'] })).toHaveLength(1);
  });

  it("reads a routine's kind as it is now, so a run from before it became a task is named (accepted, decisions row 13)", async () => {
    const digest = await create('digest', RoutineDefinitionSchema.parse({ name: 'Weekly digest', promptBody: 'Summarize.', trigger: { kind: 'interval', every: '15m' } }));
    await run(digest, 'before', 'c-before');
    expect(await ask(['c-before'])).toStrictEqual([]);
    await sql`UPDATE routines_v1_definitions SET kind = 'stay-on-top', good_when = 'Nothing waits a day.' WHERE routine_id = ${digest.routineId}`.execute(f.db);
    expect(await ask(['c-before'])).toStrictEqual([{ conversationId: 'c-before', routineId: digest.routineId, name: 'Weekly digest' }]);
  });

  it("reads through version 5's conversation index", async () => {
    const compiled = tasksForConversationsQuery({ agentId: 'a', actorUserId: 'owner', conversationIds: ['c1', 'c2'] }).compile(f.db);
    // The planner may still pick a scan on a tiny table; with scans priced out, the query reads the index.
    const plan = await f.db.connection().execute(async conn => {
      await sql`SET enable_seqscan = off`.execute(conn);
      try {
        return (await conn.executeQuery<{ 'QUERY PLAN': string }>(CompiledQuery.raw(`EXPLAIN ${compiled.sql}`, [...compiled.parameters]))).rows
          .map(row => row['QUERY PLAN']).join('\n');
      } finally {
        await sql`RESET enable_seqscan`.execute(conn);
      }
    });
    // The open-runs index, `routines_v1_dispatches_open_conversation`, doesn't contain this name.
    expect(plan).toContain('routines_v1_dispatches_conversation');
    // A lookup on both of the index's columns, not a walk of the whole index for every id: without
    // the inner `agent_id` match the plan still names the index, with only `conversation_id` as its
    // condition (TASK-932 review).
    expect(plan).toMatch(/Index Cond: \(\(agent_id = [^)]+\) AND \(conversation_id = c\.conversation_id\)\)/);
    // At most two of a conversation's runs, however many a shared conversation has gathered.
    expect(plan).toContain('Limit');
  });
});

describe('routines:tasks-for-conversations (TASK-932)', () => {
  /**
   * The hook, on a bus whose agents:resolve refuses anyone outside `reach`.
   * `order` records agents:resolve and each read of the store, as they run.
   */
  function services({ reach, allowed = true }: { reach: readonly string[]; allowed?: boolean }) {
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
    registerRoutineServices({ bus, now: () => now, store: {
      ...store,
      async tasksForConversations(input) { order.push('store'); return store.tasksForConversations(input); },
    } });
    const lookup = (userId: string, input: unknown) => bus.call<unknown, RoutineTasksForConversationsOutput>(
      'routines:tasks-for-conversations', makeAgentContext({ userId, agentId: 'a', sessionId: 's' }), input);
    return { order, lookup };
  }
  const ownersCheckIn = (routineId: string) => ({ checkIns: [{ conversationId: 'c1', routineId, name: 'Support queue' }] });

  it('runs agents:resolve before it reads, and a caller it refuses reads nothing', async () => {
    const task = await create('task', taskDefinition());
    await run(task, 'run', 'c1');
    const { order, lookup } = services({ reach: ['owner'] });
    expect(await lookup('owner', { agentId: 'a', conversationIds: ['c1'] })).toStrictEqual(ownersCheckIn(task.routineId));
    expect(order).toEqual(['agents:resolve', 'store']);
    order.length = 0;
    await expect(lookup('stranger', { agentId: 'a', conversationIds: ['c1'] })).rejects.toMatchObject({ code: 'forbidden' });
    expect(order).toEqual(['agents:resolve']);
  });

  it("answers only for the caller's own tasks", async () => {
    const task = await create('task', taskDefinition());
    await run(task, 'run', 'c1');
    const { lookup } = services({ reach: ['owner', 'teammate'] });
    // The teammate reaches the agent, but the task is the owner's: they hear what a conversation
    // that's no check-in at all would answer, and its name goes only to its owner.
    expect(await lookup('teammate', { agentId: 'a', conversationIds: ['c1'] })).toStrictEqual({ checkIns: [] });
    expect(await lookup('owner', { agentId: 'a', conversationIds: ['c1'] })).toStrictEqual(ownersCheckIn(task.routineId));
  });

  it("answers a task's owner who no longer manages the agent's tasks (decisions row 6)", async () => {
    const task = await create('task', taskDefinition());
    await run(task, 'run', 'c1');
    // A label on their own approvals: agents:resolve gates it, agents:can-manage-routines' answer doesn't.
    const { lookup } = services({ reach: ['owner'], allowed: false });
    expect(await lookup('owner', { agentId: 'a', conversationIds: ['c1'] })).toStrictEqual(ownersCheckIn(task.routineId));
  });

  it("refuses an empty list, more than 200 ids, an id that can't be one and any other key, before anything is read", async () => {
    const { order, lookup } = services({ reach: ['owner'] });
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `c${i}`);
    const refused: Array<[label: string, input: unknown]> = [
      ['an empty list', { agentId: 'a', conversationIds: [] }],
      ['201 ids', { agentId: 'a', conversationIds: ids(201) }],
      ['an empty id', { agentId: 'a', conversationIds: [''] }],
      // The owner is always the caller: an input can't name one.
      ['a userId of its own', { agentId: 'a', conversationIds: ['c1'], userId: 'owner' }],
      ['no agentId', { conversationIds: ['c1'] }],
    ];
    for (const [label, input] of refused) await expect(lookup('owner', input), label).rejects.toMatchObject({ toolCode: 'validation' });
    expect(order).toEqual([]);
    // The cap itself is taken: 200 ids no run is bound to answer nothing.
    expect(await lookup('owner', { agentId: 'a', conversationIds: ids(200) })).toStrictEqual({ checkIns: [] });
    expect(order).toEqual(['agents:resolve', 'store']);
  });
});
