import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { HookBus, makeAgentContext, PluginError, SafeToolError, type AgentContext } from '@ax/core';
import {
  RoutineDefinitionSchema, type RoutineCompleteOutput, type RoutineDefinition, type RoutineListOutput, type RoutineReopenOutput, type RoutineView,
} from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { logged } from './support/report-log.js';
import { registerRoutineServices } from '../services.js';
import type { RoutinesStore } from '../store.js';
import type { AcceptedDispatch } from '../types.js';

// TASK-950: `routines:complete` (Mark done) and `routines:reopen` (Not yet, and Reopen on a Done task), over
// routines' real store and Postgres, and who sees a task's claim and its Done. Only the task's owner, while they
// manage the agent's tasks, marks it done or reopens a Done one; Not yet on a task that isn't Done needs only
// ownership, like a reply. Reopen stores a reply, and its check-in follows the reply's rules. A task's claim and
// when it was marked done reach its owner alone.
const f = fixture();

const TASK = RoutineDefinitionSchema.parse({
  name: 'Move the help docs', promptBody: 'Move our help docs to the new site.', trigger: { kind: 'interval', every: '1h' },
  kind: 'get-done', goodWhen: 'Every article is on the new site.',
});
const STAY = RoutineDefinitionSchema.parse({
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
});
type Key = { agentId: string; routineId: string };
type Revisioned = Key & { revision: string };
const MISSING: Key = { agentId: 'a', routineId: 'rtn_missing' };
const keyOf = (row: Key): Key => ({ agentId: row.agentId, routineId: row.routineId });
/** A task 'owner' owns ('editor' made it). Each create needs its own request id: createInput's default would replay. */
const createTask = (requestId = 'task', definition: RoutineDefinition = TASK) => f.store.createAuthored({ ...createInput(requestId), definition });
const pause = (row: Revisioned) => f.store.updateAuthored({
  ...keyOf(row), expectedRevision: row.revision, actorUserId: 'owner', requestId: `pause-${row.routineId}`, patch: { enabled: false }, now, stopOnly: false,
});
/** Mark done's input. */
const press = (row: Key, requestId: string) => ({ ...keyOf(row), requestId });
/** Not yet's input, and Reopen's. */
const answer = (row: Key, requestId: string, text: string) => ({ ...keyOf(row), requestId, text });
/** The routine's whole row as stored: what a refused press must leave as it is. */
const storedRow = (routineId: string) =>
  f.db.selectFrom('routines_v1_definitions').selectAll().where('routine_id', '=', routineId).executeTakeFirst();
const storedReplies = async () => (await sql<{ request_id: string; body: string }>`
  SELECT request_id, body FROM routines_v1_replies ORDER BY created_at, reply_id`.execute(f.db)).rows;
/** Every accepted check-in's receipt: who started it, under which request id. */
const dispatchReceipts = async () => (await sql<{ owner_user_id: string; request_id: string }>`
  SELECT owner_user_id, request_id FROM routines_v1_requests WHERE operation = 'dispatch' ORDER BY request_id`.execute(f.db)).rows;
/** How many receipts Mark done keeps, for any request. */
const completeReceipts = async () => Number((await sql<{ n: string }>`
  SELECT count(*)::text AS n FROM routines_v1_requests WHERE operation = 'complete'`.execute(f.db)).rows[0]!.n);
/** The lines with this message, parsed. */
const entriesOf = (lines: readonly string[], msg: string) =>
  lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(entry => entry.msg === msg);
const REPLY_ID = expect.stringMatching(/^reply_/);

/**
 * The routines services on a bus whose agents:resolve refuses anyone outside `reach`, over the real store with
 * `store`'s methods swapped in. `allowed` is agents:can-manage-routines' answer. `dispatched` holds each check-in a
 * reopen started; `order` records agents:resolve and each Mark done and Reopen write, as they run.
 */
function services({ reach = ['owner', 'editor', 'teammate'], allowed = true, store: swapped = {}, dispatch = true, admitDispatch }: {
  reach?: readonly string[]; allowed?: boolean; store?: Partial<RoutinesStore>; dispatch?: boolean;
  admitDispatch?: <T>(effect: () => Promise<T>) => Promise<T>;
} = {}) {
  const order: string[] = [];
  const dispatched: AcceptedDispatch[] = [];
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
    store: {
      ...store,
      async completeTask(input) { order.push('completeTask'); return store.completeTask(input); },
      async reopenTask(input) { order.push('reopenTask'); return store.reopenTask(input); },
      ...swapped,
    },
    ...(dispatch ? { dispatch: async (accepted: AcceptedDispatch) => { dispatched.push(accepted); return { status: 'ok' as const }; } } : {}),
    ...(admitDispatch === undefined ? {} : { admitDispatch }),
  });
  // Each context keeps its own log lines, so a run prints none.
  const as = (userId: string) => logged(makeAgentContext({ userId, agentId: 'a', sessionId: 's' })).ctx;
  return {
    bus, order, dispatched, as,
    complete: (input: unknown, ctx: AgentContext = as('owner')) => bus.call<unknown, RoutineCompleteOutput>('routines:complete', ctx, input),
    reopen: (input: unknown, ctx: AgentContext = as('owner')) => bus.call<unknown, RoutineReopenOutput>('routines:reopen', ctx, input),
    get: (row: Key, userId = 'owner') => bus.call<unknown, RoutineView>('routines:get', as(userId), keyOf(row)),
    listed: async (row: Key, userId = 'owner') =>
      (await bus.call<unknown, RoutineListOutput>('routines:list', as(userId), { agentId: 'a' })).routines.find(view => view.routineId === row.routineId),
  };
}
type Services = ReturnType<typeof services>;
const CLAIM = { status: 'needs-you', update: 'Every article is on the new site.', ask: null, done: true } as const;
/**
 * A check-in of the task, at its current revision, that says it thinks the task is done: the report goes through
 * routines:report from the run's own context, as its runner's tool call would, and the run then ends.
 */
async function claimed<R extends Revisioned>(s: Services, row: R): Promise<R> {
  const { accepted } = (await f.store.acceptDispatch({
    ...keyOf(row), expectedRevision: row.revision, actorUserId: 'owner', source: 'manual', requestId: `claim-${row.routineId}`, now,
  }))!;
  const conversationId = `c-${accepted.dispatchId}`;
  await f.store.bindDispatchConversation({ dispatchId: accepted.dispatchId, conversationId });
  const runner = logged(makeAgentContext({ userId: 'owner', agentId: 'a', sessionId: 's', source: 'routine', conversationId })).ctx;
  expect(await s.bus.call('routines:report', runner, { agentId: 'a', dispatchId: accepted.dispatchId, ...CLAIM })).toStrictEqual({ recorded: true });
  expect(await f.store.finishDispatch({
    dispatchId: accepted.dispatchId, outcome: { status: 'ok', conversationId, error: null, renderedPrompt: null, warning: null },
  })).toBe(true);
  expect((await s.get(row)).task?.doneClaimed).toBe(true);
  return row;
}

describe('routines:complete (TASK-950)', () => {
  it('routines:complete marks the owner’s task done, once, and says so in one line', async () => {
    const task = await createTask();
    const s = services();
    const log = logged(s.as('owner'));
    expect(await s.complete(press(task, 'p1'), log.ctx)).toStrictEqual({ done: true });
    const lines = entriesOf(log.lines, 'routines_task_completed');
    expect(lines).toEqual([expect.objectContaining({ level: 'info', agentId: 'a', routineId: task.routineId })]);
    for (const key of Object.keys(lines[0]!)) expect(['level', 'ts', 'reqId', 'msg', 'agentId', 'routineId'], key).toContain(key);
    expect(s.order).toEqual(['agents:resolve', 'completeTask']);
    // It stops checking in the way a pause does. When it was marked done, never who: the owner is the only one who sees it.
    const done = await s.get(task);
    expect(done).toMatchObject({ enabled: false, nextRunAt: null });
    expect(done.done).toStrictEqual({ at: now.toISOString() });
    // Once: the same press again answers from its receipt and writes nothing.
    expect(await s.complete(press(task, 'p1'), log.ctx)).toStrictEqual({ done: true });
    expect(await s.get(task)).toEqual(done);
    expect(await completeReceipts()).toBe(1);
    expect(entriesOf(log.lines, 'routines_task_completed')).toHaveLength(1);
  });

  it('says a task was completed only for a press that moved it to Done (TASK-957)', async () => {
    const task = await createTask();
    const s = services();
    const log = logged(s.as('owner'));
    const completed = () => entriesOf(log.lines, 'routines_task_completed');
    expect(await s.complete(press(task, 'p1'), log.ctx)).toStrictEqual({ done: true });
    expect(completed()).toHaveLength(1);
    // The same press again (its receipt answers) and another press on a task already Done: both answer done, neither logs.
    expect(await s.complete(press(task, 'p1'), log.ctx)).toStrictEqual({ done: true });
    expect(await s.complete(press(task, 'p2'), log.ctx)).toStrictEqual({ done: true });
    expect(completed()).toHaveLength(1);
    // Reopened, the task runs again; the first press, retried, only replays: no write, no line.
    await s.reopen(answer(task, 'r1', 'Not yet: redirect the old links too.'), log.ctx);
    expect(await s.complete(press(task, 'p1'), log.ctx)).toStrictEqual({ done: true });
    expect(await s.get(task)).toMatchObject({ enabled: true, done: null });
    expect(completed()).toHaveLength(1);
    // A new press moves it to Done again, and says so.
    expect(await s.complete(press(task, 'p3'), log.ctx)).toStrictEqual({ done: true });
    expect(completed()).toEqual([
      expect.objectContaining({ level: 'info', agentId: 'a', routineId: task.routineId }),
      expect.objectContaining({ level: 'info', agentId: 'a', routineId: task.routineId }),
    ]);
  });

  it.each([
    ['forbidden', 'input', 'a teammate', { userId: 'teammate' }],
    ['forbidden', 'input', 'the owner, who no longer manages the agent’s tasks', { allowed: false }],
    ['not-found', 'routineId', 'a stay-on-top task', { definition: STAY }],
    ['not-found', 'routineId', 'a missing routine', { missing: true }],
  ] as const)('answers %s (%s) for %s, and the task is unchanged', async (toolCode, field, _label, setup: {
    userId?: string; allowed?: boolean; definition?: RoutineDefinition; missing?: boolean;
  }) => {
    const task = await createTask('task', setup.definition ?? TASK);
    const before = await storedRow(task.routineId);
    const s = services({ allowed: setup.allowed ?? true });
    await expect(s.complete(press(setup.missing === true ? MISSING : task, 'p1'), s.as(setup.userId ?? 'owner'))).rejects.toMatchObject({ toolCode, field });
    expect(await storedRow(task.routineId)).toEqual(before);
    expect(await completeReceipts()).toBe(0);
  });
});

describe('routines:reopen (TASK-950)', () => {
  it('routines:reopen on a Done task reopens it and starts a check-in keyed on its reply', async () => {
    const task = await createTask();
    const s = services();
    await s.complete(press(task, 'p1'));
    const done = await s.get(task);
    const log = logged(s.as('owner'));
    const text = 'Also redirect the old links: QX7731.';
    const out = await s.reopen(answer(task, 'q1', text), log.ctx);
    expect(out).toStrictEqual({ replyId: REPLY_ID, checkIn: 'started' });
    // Running again, at a new revision, and the check-in runs at it.
    const reopened = await s.get(task);
    expect(reopened).toMatchObject({ enabled: true, nextRunAt: expect.any(String), done: null });
    expect(reopened.revision).not.toBe(done.revision);
    expect(s.dispatched).toEqual([expect.objectContaining({
      source: 'manual', row: expect.objectContaining({ routineId: task.routineId, revision: reopened.revision, enabled: true }),
    })]);
    // Keyed on the reply, so a retry can't start a second, and it never shares a receipt with a Check now press.
    expect(await dispatchReceipts()).toEqual([{ owner_user_id: 'owner', request_id: `reply:${out.replyId}` }]);
    expect(await storedReplies()).toEqual([{ request_id: 'q1', body: text }]);
    const lines = entriesOf(log.lines, 'routines_task_reopened');
    expect(lines).toEqual([expect.objectContaining({ level: 'info', agentId: 'a', routineId: task.routineId, wasDone: true, checkIn: 'started' })]);
    for (const key of Object.keys(lines[0]!)) expect(['level', 'ts', 'reqId', 'msg', 'agentId', 'routineId', 'wasDone', 'checkIn'], key).toContain(key);
    expect(log.lines.join('\n')).not.toContain('QX7731');
  });

  it('its check-in follows the reply’s rules', async () => {
    const s = services();
    // A claimed task that's paused: the claim goes, and nothing starts until a person resumes it.
    const paused = await pause(await claimed(s, await createTask('paused')));
    expect(await s.reopen(answer(paused, 'q1', 'Not yet: the old links still 404.'))).toStrictEqual({ replyId: REPLY_ID, checkIn: 'paused' });
    expect((await s.get(paused)).task?.doneClaimed).toBe(false);
    // A claimed running task, answered by an owner who can no longer start its check-ins: the claim still goes.
    const running = await claimed(s, await createTask('running'));
    const unmanaged = services({ allowed: false });
    const log = logged(unmanaged.as('owner'));
    expect(await unmanaged.reopen(answer(running, 'q2', 'Not yet.'), log.ctx)).toStrictEqual({ replyId: REPLY_ID, checkIn: 'not-allowed' });
    expect(entriesOf(log.lines, 'routines_task_reopened')).toEqual([expect.objectContaining({ wasDone: false, checkIn: 'not-allowed' })]);
    expect((await s.get(running)).task?.doneClaimed).toBe(false);
    expect([...s.dispatched, ...unmanaged.dispatched]).toEqual([]);
    // The same request again, once its check-in started, replays it.
    const again = await claimed(s, await createTask('again'));
    const first = await s.reopen(answer(again, 'q3', 'Not yet.'));
    expect(first.checkIn).toBe('started');
    expect(await s.reopen(answer(again, 'q3', 'Not yet.'))).toStrictEqual({ replyId: first.replyId, checkIn: 'replayed' });
    expect(s.dispatched).toHaveLength(1);
    expect(await storedReplies()).toHaveLength(3);
  });

  it('a Done task can’t be reopened without edit, and nothing is stored', async () => {
    const task = await createTask();
    await services().complete(press(task, 'p1'));
    const before = await storedRow(task.routineId);
    const s = services({ allowed: false });
    await expect(s.reopen(answer(task, 'q1', 'Reopen it.'))).rejects.toMatchObject({ toolCode: 'forbidden', field: 'input' });
    expect(await storedReplies()).toEqual([]);
    expect(await storedRow(task.routineId)).toEqual(before);
    expect(s.dispatched).toEqual([]);
  });

  it.each([
    ['forbidden', 'input', 'a teammate, on a claimed task', 'teammate', 'claimed'],
    ['not-found', 'routineId', 'a stay-on-top task', 'owner', 'stay-on-top'],
    ['not-found', 'routineId', 'a missing routine', 'owner', 'missing'],
  ] as const)('answers %s (%s) for %s, and stores nothing', async (toolCode, field, _label, userId, target) => {
    const s = services();
    const task = target === 'stay-on-top' ? await createTask('task', STAY) : await claimed(s, await createTask());
    const before = await storedRow(task.routineId);
    await expect(s.reopen(answer(target === 'missing' ? MISSING : task, 'q1', 'Not yet.'), s.as(userId))).rejects.toMatchObject({ toolCode, field });
    expect(await storedReplies()).toEqual([]);
    expect(await storedRow(task.routineId)).toEqual(before);
    expect(s.dispatched).toEqual([]);
  });

  it('runs inside admitDispatch: a host shutting down refuses it before anything is written', async () => {
    const task = await createTask();
    await services().complete(press(task, 'p1'));
    const before = await storedRow(task.routineId);
    const s = services({ admitDispatch: async () => { throw new SafeToolError('unavailable', 'input'); } });
    await expect(s.reopen(answer(task, 'q1', 'Reopen it.'))).rejects.toMatchObject({ toolCode: 'unavailable' });
    expect(s.order).toEqual([]);
    expect(await storedReplies()).toEqual([]);
    expect(await storedRow(task.routineId)).toEqual(before);
  });

  it('asks agents:resolve first, and checks the text and the dispatcher before it writes anything', async () => {
    const task = await createTask();
    await services().complete(press(task, 'p1'));
    const before = await storedRow(task.routineId);
    // The task's owner, who can no longer reach the agent: Mark done and Reopen both stop there.
    const unreached = services({ reach: [] });
    await expect(unreached.complete(press(task, 'p2'))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(unreached.reopen(answer(task, 'q1', 'Reopen it.'))).rejects.toMatchObject({ code: 'forbidden' });
    expect(unreached.order).toEqual(['agents:resolve', 'agents:resolve']);
    // The reply's rule, blank or past 2,000 characters, before anything runs.
    const s = services();
    for (const text of [' \n ', 'x'.repeat(2001)]) await expect(s.reopen(answer(task, 'q2', text))).rejects.toMatchObject({ toolCode: 'validation' });
    expect(s.order).toEqual([]);
    // No dispatcher to start a check-in with: refused before the store.
    const undispatched = services({ dispatch: false });
    await expect(undispatched.reopen(answer(task, 'q3', 'Reopen it.'))).rejects.toMatchObject({ toolCode: 'unavailable' });
    expect(undispatched.order).toEqual(['agents:resolve']);
    expect(await storedReplies()).toEqual([]);
    expect(await storedRow(task.routineId)).toEqual(before);
  });

  it("a stored reopen whose check-in step throws leaves the reply's warn line, ids only, and rethrows", async () => {
    const task = await claimed(services(), await createTask());
    const s = services({ store: { acceptDispatch: async () => { throw new Error('connection reset QX7731'); } } });
    const log = logged(s.as('owner'));
    await expect(s.reopen(answer(task, 'q1', 'Not yet: QX7731.'), log.ctx)).rejects.toThrow('connection reset');
    const lines = entriesOf(log.lines, 'routines_reply_check_in_failed');
    expect(lines).toEqual([expect.objectContaining({ level: 'warn', agentId: 'a', routineId: task.routineId, replyId: REPLY_ID, toolCode: 'unknown' })]);
    for (const key of Object.keys(lines[0]!)) expect(['level', 'ts', 'reqId', 'msg', 'agentId', 'routineId', 'replyId', 'toolCode'], key).toContain(key);
    expect(entriesOf(log.lines, 'routines_task_reopened')).toEqual([]);
    expect(log.lines.join('\n')).not.toContain('QX7731');
    // The reply is stored, and its claim went with it.
    expect(await storedReplies()).toEqual([{ request_id: 'q1', body: 'Not yet: QX7731.' }]);
    expect((await s.get(task)).task?.doneClaimed).toBe(false);
  });
});

describe('who sees a task’s claim and its Done (TASK-950)', () => {
  it('shows done and the claim to the task’s owner only', async () => {
    const s = services();
    const task = await claimed(s, await createTask());
    for (const view of [await s.get(task), await s.listed(task)]) {
      expect(view?.task).toMatchObject({ status: 'needs-you', doneClaimed: true });
      expect(view?.done).toBeNull();
    }
    // Anyone else sees the routine without its task state, the claim with it.
    for (const view of [await s.get(task, 'teammate'), await s.listed(task, 'teammate')]) expect(view).toMatchObject({ task: null, done: null });
    expect(await s.complete(press(task, 'p1'))).toStrictEqual({ done: true });
    for (const view of [await s.get(task), await s.listed(task)]) {
      expect(view?.done).toStrictEqual({ at: now.toISOString() });
      // Mark done answers the claim, so it goes.
      expect(view?.task).toMatchObject({ status: 'needs-you', doneClaimed: false });
    }
    for (const view of [await s.get(task, 'teammate'), await s.listed(task, 'teammate')]) {
      expect(view).toMatchObject({ routineId: task.routineId, enabled: false, task: null, done: null });
    }
  });
});
