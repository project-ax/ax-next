import { inspect } from 'node:util';
import { describe, it, expect } from 'vitest';
import { sql, type Transaction } from 'kysely';
import { RoutineDefinitionSchema, ROUTINE_STEPS_MAX, type RoutineKey, type RoutineStepOp } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import type { RoutinesDatabase } from '../migrations.js';
import type { DispatchReport, StoredStep } from '../types.js';

// TASK-949: a person's changes to a get-done task's steps, as the store makes them (setSteps). Owner only, decided
// under the agent fence and the routine's row lock; applied as the person's by the helper a report's changes go
// through; kept under a receipt that holds a count and never a step's text, so the same request again changes nothing.
const f = fixture();
const minute = (n: number) => new Date(now.getTime() + n * 60_000);
const GET_DONE = RoutineDefinitionSchema.parse({
  name: 'Move the help docs', promptBody: 'Move our help docs to the new site.', trigger: { kind: 'interval', every: '1h' },
  kind: 'get-done', goodWhen: 'Every article is on the new site.',
});
const taskInput = (requestId: string) => ({ ...createInput(requestId), definition: GET_DONE });
const step = (id: string, text: string, over: Partial<StoredStep> = {}): StoredStep => ({ id, text, done: false, addedBy: 'agent', ...over });
/** `task_steps` written by hand (the agent's report, a rollback, a later version), through `db` (or a transaction). */
const writeSteps = (routineId: string, value: unknown, db = f.db) =>
  sql`UPDATE routines_v1_definitions SET task_steps = ${JSON.stringify(value)}::jsonb WHERE routine_id = ${routineId}`.execute(db);
const stepsColumn = async (routineId: string) =>
  (await sql<{ task_steps: unknown }>`SELECT task_steps FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0]?.task_steps;
/** Every receipt a person's step change left. */
const receipts = async () => (await sql<{ operation: string; request_id: string; result: unknown }>`
  SELECT operation, request_id, result FROM routines_v1_requests WHERE operation = 'set-steps' ORDER BY request_id`.execute(f.db)).rows;
/**
 * A person's change to a task's steps, as its owner unless `actorUserId` says otherwise. Async, so even a missing
 * method rejects rather than throws (reply-store.test.ts): a test holding a row lock must reach its commit.
 */
const change = async (key: RoutineKey, requestId: string, ops: RoutineStepOp[], actorUserId = 'owner') =>
  f.store.setSteps({ agentId: key.agentId, routineId: key.routineId, actorUserId, requestId, ops });
/** setSteps' answer when it changed or replayed; a refusal fails the test. */
const changed = async (...args: Parameters<typeof change>) => {
  const result = await change(...args);
  if (typeof result === 'string') throw new Error(`setSteps answered ${result}`);
  return result;
};
/** Resolves once some session waits on a lock that backend `pid` holds; fails after five seconds. */
async function waitsOn(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`.execute(f.db);
    if (rows[0]!.n > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Nothing waited on backend ${pid}.`);
}
/**
 * Starts `waiter` while another writer holds the task's row lock, as setSteps and recordReport take it. Once the
 * waiter waits on that lock, `meanwhile` makes the other writer's change in the holding transaction, which then
 * commits. Resolves to the waiter's answer.
 */
async function whileHeld<T>(key: RoutineKey, waiter: () => Promise<T>, meanwhile: (trx: Transaction<RoutinesDatabase>) => Promise<unknown>): Promise<T> {
  const { waiting } = await f.db.transaction().execute(async trx => {
    const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid FROM routines_v1_definitions WHERE agent_id = ${key.agentId} AND routine_id = ${key.routineId} FOR UPDATE`.execute(trx);
    const waiting = waiter();
    waiting.catch(() => {}); // awaited below, once the hold ends
    await waitsOn(rows[0]!.pid);
    await meanwhile(trx);
    return { waiting };
  });
  return waiting;
}
const onTrack = { status: 'on-track', update: 'Moving.', ask: null } as const;
/** A run of the routine at its current revision, accepted at `at` and bound to its own conversation. */
const bound = async (key: RoutineKey, requestId: string, at: Date) => {
  const row = (await f.store.findOne(key))!;
  const { accepted } = (await f.store.acceptDispatch({
    agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', source: 'manual', requestId, now: at,
  }))!;
  await f.store.bindDispatchConversation({ dispatchId: accepted.dispatchId, conversationId: `c-${requestId}` });
  return { ...accepted, conversationId: `c-${requestId}` };
};
const record = (run: Awaited<ReturnType<typeof bound>>, report: DispatchReport, steps: RoutineStepOp[]) => f.store.recordReport({
  agentId: run.row.agentId, dispatchId: run.dispatchId, conversationId: run.conversationId, actorUserId: 'owner', report, steps, now: minute(30),
});

describe("a person's step changes (store, TASK-949)", () => {
  it('an owner’s add is the person’s, and the answer is the list as it is now', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const answer = await changed(task, 'r1', [{ op: 'add', text: 'Ask Dana to review billing' }]);
    expect(answer).toEqual({ steps: [{ id: expect.stringMatching(/^s[0-9a-z]{6}$/), text: 'Ask Dana to review billing', done: false, addedBy: 'person' }], skipped: 0, replayed: false });
    expect(await stepsColumn(task.routineId)).toEqual(answer.steps);
  });

  it('a person may reword and remove the agent’s steps, and a reworded step is theirs', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await writeSteps(task.routineId, [step('s000001', 'Email all 500 customers'), step('s000002', 'Draft the announcement')]);
    const after = [step('s000001', 'Email the five VIPs', { addedBy: 'person' })];
    expect(await change(task, 'r1', [{ op: 'edit', id: 's000001', text: 'Email the five VIPs' }, { op: 'remove', id: 's000002' }]))
      .toEqual({ steps: after, skipped: 0, replayed: false });
    expect(await stepsColumn(task.routineId)).toEqual(after);
  });

  it('a change to a step that’s gone, an add past 50 and an add already listed are skipped and counted', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const full = Array.from({ length: ROUTINE_STEPS_MAX }, (_, i) => step(`s${String(i + 1).padStart(6, '0')}`, `Step ${i + 1}`));
    await writeSteps(task.routineId, full);
    expect(await change(task, 'r1', [{ op: 'tick', id: 'sgone00' }, { op: 'add', text: 'One more' }, { op: 'add', text: 'Step 1' }]))
      .toEqual({ steps: full, skipped: 3, replayed: false });
    expect(await stepsColumn(task.routineId)).toEqual(full);
  });

  it('only the owner may: someone else is forbidden, and nothing is written or kept', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    expect(await change(task, 'r1', [{ op: 'add', text: 'Skip the review' }], 'teammate')).toBe('forbidden');
    // The person who made the task doesn't own it either.
    expect(await change(task, 'r1', [{ op: 'add', text: 'Skip the review' }], 'editor')).toBe('forbidden');
    expect(await stepsColumn(task.routineId)).toEqual([]);
    expect(await receipts()).toEqual([]);
  });

  it('a stay-on-top task, a repeat routine and a missing one are not-found, and nothing is written or kept', async () => {
    const stay = await f.store.createAuthored({ ...createInput('stay'), definition: RoutineDefinitionSchema.parse({
      name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
      kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
    }) });
    const repeat = await f.store.createAuthored(createInput('repeat'));
    const gone = await f.store.createAuthored(taskInput('gone'));
    await f.store.deleteAuthored({ agentId: 'a', routineId: gone.routineId, expectedRevision: gone.revision, actorUserId: 'owner', requestId: 'delete', now });
    for (const routineId of [stay.routineId, repeat.routineId, gone.routineId, 'rtn_never']) {
      expect(await change({ agentId: 'a', routineId }, `r-${routineId}`, [{ op: 'add', text: 'Export every article' }]), routineId).toBe('not-found');
    }
    expect(await stepsColumn(stay.routineId)).toEqual([]);
    expect(await stepsColumn(repeat.routineId)).toEqual([]);
    expect(await receipts()).toEqual([]);
  });

  it('a stranger on a stay-on-top task gets not-found, the same as the owner does, never forbidden', async () => {
    const stay = await f.store.createAuthored({ ...createInput('stay'), definition: RoutineDefinitionSchema.parse({
      name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
      kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
    }) });
    const add: RoutineStepOp[] = [{ op: 'add', text: 'Export every article' }];
    expect(await change(stay, 'r1', add, 'teammate')).toBe('not-found');
    expect(await change(stay, 'r1', add, 'owner')).toBe('not-found');
    expect(await stepsColumn(stay.routineId)).toEqual([]);
    expect(await receipts()).toEqual([]);
  });

  it('a retired agent is not-found', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await f.store.purgeAgent('a');
    await expect(change(task, 'r1', [{ op: 'add', text: 'Export every article' }])).rejects.toMatchObject({ toolCode: 'not-found' });
    expect(await receipts()).toEqual([]);
  });

  it('a change never moves the routine’s revision, spec hash or updated time', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const stamps = async () => (await sql<{ revision: string; spec_hash: string; updated_at: Date }>`
      SELECT revision, spec_hash, updated_at FROM routines_v1_definitions WHERE routine_id = ${task.routineId}`.execute(f.db)).rows[0];
    const before = await stamps();
    await changed(task, 'r1', [{ op: 'add', text: 'Export every article' }]);
    expect(await stepsColumn(task.routineId)).toHaveLength(1);
    expect(await stamps()).toEqual(before);
  });

  it('the same request again changes nothing and answers the steps as they are now', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const add: RoutineStepOp[] = [{ op: 'add', text: 'Export every article' }];
    const [exported] = (await changed(task, 'r1', add)).steps;
    // The agent ticks it at a check-in before the page's retry (an answer lost on the way back) arrives.
    const run = await bound(task, 'run', minute(1));
    expect(await record(run, onTrack, [{ op: 'tick', id: exported!.id }])).toEqual({ outcome: 'recorded', applied: 1, skipped: 0 });
    // The first try's count (an add applied again would be skipped as already listed), and the steps as they are now.
    expect(await change(task, 'r1', add)).toEqual({ steps: [{ ...exported, done: true }], skipped: 0, replayed: true });
    expect(await stepsColumn(task.routineId)).toEqual([{ ...exported, done: true }]);
    // Once the person deletes the step, the first request again still doesn't bring it back.
    expect(await change(task, 'r2', [{ op: 'remove', id: exported!.id }])).toEqual({ steps: [], skipped: 0, replayed: false });
    expect(await change(task, 'r1', add)).toEqual({ steps: [], skipped: 0, replayed: true });
    expect(await stepsColumn(task.routineId)).toEqual([]);
  });

  it('the receipt keeps the count and no step text', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    expect(await change(task, 'r1', [{ op: 'add', text: 'SECRET step' }, { op: 'tick', id: 'sgone00' }]))
      .toMatchObject({ skipped: 1 });
    expect(await receipts()).toEqual([{ operation: 'set-steps', request_id: 'r1', result: { skipped: 1 } }]);
    expect(JSON.stringify(await receipts())).not.toContain('SECRET');
  });

  it('the same request id with other changes, or on another task, is refused', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const other = await f.store.createAuthored(taskInput('other'));
    await changed(task, 'r1', [{ op: 'add', text: 'Export every article' }]);
    await expect(change(task, 'r1', [{ op: 'add', text: 'Upload them' }])).rejects.toMatchObject({ toolCode: 'request-conflict' });
    // A receipt's key names no routine, so only its hash keeps one task's request from answering for another's.
    await expect(change(other, 'r1', [{ op: 'add', text: 'Export every article' }])).rejects.toMatchObject({ toolCode: 'request-conflict' });
    expect(((await stepsColumn(task.routineId)) as StoredStep[]).map(entry => entry.text)).toEqual(['Export every article']);
    expect(await stepsColumn(other.routineId)).toEqual([]);
  });

  it('a replay checks the owner and the routine again', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const add: RoutineStepOp[] = [{ op: 'add', text: 'Export every article' }];
    await changed(task, 'r1', add);
    await sql`UPDATE routines_v1_definitions SET owner_user_id = 'someone-else' WHERE routine_id = ${task.routineId}`.execute(f.db);
    expect(await change(task, 'r1', add)).toBe('forbidden');
    await sql`UPDATE routines_v1_definitions SET owner_user_id = 'owner' WHERE routine_id = ${task.routineId}`.execute(f.db);
    await f.store.deleteAuthored({ agentId: 'a', routineId: task.routineId, expectedRevision: task.revision, actorUserId: 'owner', requestId: 'delete', now });
    expect(await change(task, 'r1', add)).toBe('not-found');
  });

  it('a replay that waits on the task’s row lock answers the steps, and the owner, as that writer left them', async () => {
    const add: RoutineStepOp[] = [{ op: 'add', text: 'Export every article' }];
    // The steps: the holder ticks the step and adds one, and the replay answers both.
    const task = await f.store.createAuthored(taskInput('task'));
    const [exported] = (await changed(task, 'r1', add)).steps;
    const upload = step('s000002', 'Upload them');
    const after = [{ ...exported!, done: true }, upload];
    expect(await whileHeld(task,
      () => change(task, 'r1', add),
      trx => writeSteps(task.routineId, after, trx),
    )).toEqual({ steps: after, skipped: 0, replayed: true });
    // The owner: the holder hands the task over, and the replay is refused. It reads the owner under the lock too.
    const other = await f.store.createAuthored(taskInput('other'));
    await changed(other, 'r2', add);
    expect(await whileHeld(other,
      () => change(other, 'r2', add),
      trx => sql`UPDATE routines_v1_definitions SET owner_user_id = 'someone-else' WHERE routine_id = ${other.routineId}`.execute(trx),
    )).toBe('forbidden');
  });

  it('a person’s change and a report that wait on each other both land, in either order', async () => {
    // Each writer reads the checklist under the task's row lock, so one that waits there reads what the other just
    // committed (READ COMMITTED). Read before the lock, it would write over that change.
    const exported = step('s000001', 'Export every article');
    const upload = step('s000002', 'Upload them');
    const both = [{ ...exported, done: true }, { ...upload, text: 'Upload all 142', addedBy: 'person' }];
    // The person's change waits on a report that ticks the first step.
    const task = await f.store.createAuthored(taskInput('task'));
    await writeSteps(task.routineId, [exported, upload]);
    expect(await whileHeld(task,
      () => change(task, 'r1', [{ op: 'edit', id: upload.id, text: 'Upload all 142' }]),
      trx => writeSteps(task.routineId, [{ ...exported, done: true }, upload], trx),
    )).toEqual({ steps: both, skipped: 0, replayed: false });
    expect(await stepsColumn(task.routineId)).toEqual(both);
    // A report waits on the person's change that rewords the second step.
    const other = await f.store.createAuthored(taskInput('other'));
    await writeSteps(other.routineId, [exported, upload]);
    const run = await bound(other, 'run', minute(1));
    expect(await whileHeld(other,
      () => record(run, onTrack, [{ op: 'tick', id: exported.id }]),
      trx => writeSteps(other.routineId, [exported, { ...upload, text: 'Upload all 142', addedBy: 'person' }], trx),
    )).toEqual({ outcome: 'recorded', applied: 1, skipped: 0 });
    expect(await stepsColumn(other.routineId)).toEqual(both);
  });

  it('a change keeps the stored entries this version can’t read', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const later = { ...step('s000002', 'From later'), addedBy: 'app' };
    await writeSteps(task.routineId, [step('s000001', 'Export every article'), later]);
    expect(await change(task, 'r1', [{ op: 'tick', id: 's000001' }]))
      .toEqual({ steps: [step('s000001', 'Export every article', { done: true })], skipped: 0, replayed: false });
    expect(await stepsColumn(task.routineId)).toEqual([step('s000001', 'Export every article', { done: true }), later]);
  });

  it('a checklist that isn’t a list skips every change and is left as it is', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await writeSteps(task.routineId, { not: 'a list' });
    expect(await change(task, 'r1', [{ op: 'add', text: 'Export every article' }])).toEqual({ steps: [], skipped: 1, replayed: false });
    expect(await stepsColumn(task.routineId)).toEqual({ not: 'a list' });
  });

  it('a checklist write that fails names only the routine and the SQLSTATE, and keeps no receipt', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await sql`ALTER TABLE routines_v1_definitions ADD CONSTRAINT task_949_no_steps CHECK (jsonb_array_length(task_steps) = 0)`.execute(f.db);
    let failure: unknown;
    try {
      failure = await change(task, 'r1', [{ op: 'add', text: 'SECRET step text' }]).then(() => null, (error: unknown) => error);
    } finally {
      await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT IF EXISTS task_949_no_steps`.execute(f.db);
    }
    expect((failure as Error).message).toBe(`Could not save the steps for routine ${task.routineId} (SQLSTATE 23514).`);
    expect(inspect(failure)).not.toContain('SECRET');
    expect(await receipts()).toEqual([]);
    expect(await stepsColumn(task.routineId)).toEqual([]);
  });
});
