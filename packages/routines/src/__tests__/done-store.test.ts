import { afterEach, describe, it, expect, vi } from 'vitest';
import { sql, type Transaction } from 'kysely';
import { RoutineDefinitionSchema, TASK_AUTO_PAUSE_AFTER_MISSES, type RoutineDefinition, type RoutineKey, type RoutinePatch } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { captureExpectedStderr } from './support/expected-diagnostics.js';
import { StoredRoutineSchema } from '../definition.js';
import type { RoutinesDatabase } from '../migrations.js';
import type { DispatchOutcome, DispatchReport, RecordReportInput, StoredStep } from '../types.js';

// TASK-950: a "get-done" task's claim that it's done, and Done itself, as the store keeps them. The claim is
// the time of the report that made it, so it reads only beside that report. Done is a completion that counts
// only while the task is off, get-done, and completed by its owner (`doneOf`). The first describe marks a task
// done by hand, with the columns Mark done writes: off, and completed by its owner. The last two drive Mark
// done and Reopen themselves (`completeTask`, `reopenTask`).
const f = fixture();
afterEach(() => { vi.restoreAllMocks(); });
const minute = (n: number) => new Date(now.getTime() + n * 60_000);
const GET_DONE = RoutineDefinitionSchema.parse({
  name: 'Move the help docs', promptBody: 'Move our help docs to the new site.', trigger: { kind: 'interval', every: '1h' },
  kind: 'get-done', goodWhen: 'Every article is on the new site.',
});
const STAY = RoutineDefinitionSchema.parse({
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '1h' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
});
/** A task 'owner' owns ('editor' made it). Each create needs its own request id: createInput's default would replay. */
const taskInput = (requestId: string, definition: RoutineDefinition = GET_DONE) => ({ ...createInput(requestId), definition });
const needsYouDone = { status: 'needs-you', update: 'Every article is on the new site.', ask: null } as const;
const onTrack = { status: 'on-track', update: 'Found two more articles.', ask: null } as const;
/** A run of the routine at its current revision, accepted at `at` and bound to its own conversation. */
const bound = async (key: RoutineKey, requestId: string, at: Date) => {
  const row = (await f.store.findOne(key))!;
  const { accepted } = (await f.store.acceptDispatch({
    agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', source: 'manual', requestId, now: at,
  }))!;
  await f.store.bindDispatchConversation({ dispatchId: accepted.dispatchId, conversationId: `c-${requestId}` });
  return { ...accepted, conversationId: `c-${requestId}` };
};
type Run = Awaited<ReturnType<typeof bound>>;
/** The run's report, sent at minute 30 unless `over` says otherwise. */
const record = (run: Run, report: DispatchReport, over: Partial<Pick<RecordReportInput, 'done' | 'notes' | 'steps' | 'now'>> = {}) => f.store.recordReport({
  agentId: run.row.agentId, dispatchId: run.dispatchId, conversationId: run.conversationId, actorUserId: 'owner', report, now: minute(30), ...over,
});
const OK: DispatchOutcome = { status: 'ok', conversationId: 'c', error: null, renderedPrompt: 'ran', warning: null };
/** The run's end, as fire.ts records it. */
const finish = async (run: Run, outcome: Partial<DispatchOutcome> = {}) => {
  expect(await f.store.finishDispatch({ dispatchId: run.dispatchId, outcome: { ...OK, conversationId: run.conversationId, ...outcome } })).toBe(true);
};
/**
 * A completion written by hand at minute 40: off, as Mark done leaves it, or running, as code from before
 * version 12 leaves a Done task it resumed. Mark done also mints a revision and clears the claim; this doesn't.
 */
const setCompletion = (routineId: string, { enabled, by }: { enabled: boolean; by: string | null }) => sql`
  UPDATE routines_v1_definitions SET enabled = ${enabled}, task_completed_at = ${minute(40)}, task_completed_by_user_id = ${by}
   WHERE routine_id = ${routineId}`.execute(f.db);
const markDoneByHand = (routineId: string, by = 'owner') => setCompletion(routineId, { enabled: false, by });
type Columns = {
  enabled: boolean; task_done_claimed_at: Date | null; task_completed_at: Date | null; task_completed_by_user_id: string | null;
  task_reported_at: Date | null; task_misses_in_a_row: number;
};
/** The claim's and the completion's columns, beside the report's time and the misses, as stored. */
const columns = async (routineId: string) => (await sql<Columns>`
  SELECT enabled, task_done_claimed_at, task_completed_at, task_completed_by_user_id, task_reported_at, task_misses_in_a_row
    FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0]!;
/** A person's edit, as routines:update makes it. */
const edit = (row: RoutineKey & { revision: string }, requestId: string, patch: RoutinePatch) => f.store.updateAuthored({
  agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', requestId, patch, now, stopOnly: false,
});
const pausedLine = (routineId: string) =>
  `[ax/routines] auto-paused task a/${routineId} after ${TASK_AUTO_PAUSE_AFTER_MISSES} check-ins without a report\n`;
/** The auto-pause's stderr lines, captured until the test ends. Anything else still prints. */
const pauseLines = () => captureExpectedStderr(message => message.startsWith('[ax/routines] auto-paused task ')).messages;
/** The routine's row, read under its lock: what Mark done holds until it commits. */
const lockRow = (trx: Transaction<RoutinesDatabase>, key: RoutineKey) => trx.selectFrom('routines_v1_definitions').select('routine_id')
  .where('agent_id', '=', key.agentId).where('routine_id', '=', key.routineId).forUpdate().execute();
/** Backends waiting on a lock in a statement on routines' definitions table. */
const waitingOnRoutineRow = async () => Number((await sql<{ n: string }>`
  SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%routines_v1_definitions%'`.execute(f.db)).rows[0]!.n);
type Step = (trx: Transaction<RoutinesDatabase>) => Promise<unknown>;
/** Runs `before` in a transaction that then stays open, holding its locks, until `release()`; then runs `after` and commits. */
async function openTransaction(before: Step, after: Step = async () => {}) {
  let release!: () => void; let began!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { began = resolve; });
  const done = f.db.transaction().execute(async trx => { await before(trx); began(); await hold; await after(trx); });
  await Promise.race([ready, done]);
  return { release, done };
}
type Press = { actorUserId?: string; mayEdit?: boolean; now?: Date };
// Async, so even a missing method rejects rather than throws.
/** Mark done, as routines:complete asks for it: by the task's owner, who manages the agent's tasks, at minute 50. */
const complete = async (key: RoutineKey, requestId: string, over: Press = {}) => f.store.completeTask({
  agentId: key.agentId, routineId: key.routineId, actorUserId: 'owner', requestId, mayEdit: true, now: minute(50), ...over,
});
/** Not yet, or Reopen on a Done task, as routines:reopen asks for it: the owner's reply, at minute 55. */
const reopen = async (key: RoutineKey, requestId: string, text: string, over: Press = {}) => f.store.reopenTask({
  agentId: key.agentId, routineId: key.routineId, actorUserId: 'owner', requestId, text, mayEdit: true, now: minute(55), ...over,
});
/** reopenTask's answer when it stored or found a reply; a refusal fails the test. */
const reopened = async (...args: Parameters<typeof reopen>) => {
  const result = await reopen(...args);
  if (typeof result === 'string') throw new Error(`reopenTask answered ${result}`);
  return result;
};
/** How many receipts Mark done keeps, for any request. */
const completeReceipts = async () => Number((await sql<{ n: string }>`
  SELECT count(*)::text AS n FROM routines_v1_requests WHERE operation = 'complete'`.execute(f.db)).rows[0]!.n);
/** Every reply stored, on any task, oldest first. */
const storedReplies = async () => (await sql<{ request_id: string; body: string }>`
  SELECT request_id, body FROM routines_v1_replies ORDER BY created_at, reply_id`.execute(f.db)).rows;
/** The routine's whole row as stored: what Mark done and Reopen write, and what they must leave as it is. */
const storedRow = (routineId: string) =>
  f.db.selectFrom('routines_v1_definitions').selectAll().where('routine_id', '=', routineId).executeTakeFirst();
const STEPS: StoredStep[] = [
  { id: 's000001', text: 'Export every article', done: true, addedBy: 'agent' },
  { id: 's000002', text: 'Redirect the old links', done: false, addedBy: 'person' },
];
/** `task_steps` written by hand, as steps-store.test.ts writes them. */
const setSteps = (routineId: string, steps: StoredStep[]) =>
  sql`UPDATE routines_v1_definitions SET task_steps = ${JSON.stringify(steps)}::jsonb WHERE routine_id = ${routineId}`.execute(f.db);
/** `inARow` check-ins without a report, the latest at minute 0, written by hand. */
const setMisses = (routineId: string, inARow: number) => sql`
  UPDATE routines_v1_definitions SET task_misses_in_a_row = ${inARow}, task_miss_reason = 'no-report', task_miss_at = ${minute(0)}
   WHERE routine_id = ${routineId}`.execute(f.db);

describe("a task's claim and Done, as the store keeps them (TASK-950)", () => {
  it('a report with done claims the task, and the next report without it takes the claim back', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    expect(await record(await bound(task, 'run-1', minute(1)), needsYouDone, { done: true })).toBe('recorded');
    expect((await f.store.findOne(task))?.task).toMatchObject({ status: 'needs-you', doneClaimed: true });
    // The claim is the time of the report that made it.
    const claimed = await columns(task.routineId);
    expect(claimed.task_done_claimed_at).toEqual(minute(30));
    expect(claimed.task_done_claimed_at).toEqual(claimed.task_reported_at);
    // A later check-in's report, in the same instant, says nothing of done.
    expect(await record(await bound(task, 'run-2', minute(2)), onTrack)).toBe('recorded');
    expect((await f.store.findOne(task))?.task).toMatchObject({ status: 'on-track', update: 'Found two more articles.', doneClaimed: false });
    expect((await columns(task.routineId)).task_done_claimed_at).toBeNull();
  });

  it('an older check-in’s claim doesn’t replace a newer report', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const older = await bound(task, 'older', minute(1));
    const newer = await bound(task, 'newer', minute(2));
    expect(await record(newer, onTrack)).toBe('recorded');
    expect(await record(older, needsYouDone, { done: true })).toBe('recorded');
    expect((await f.store.findOne(task))?.task).toMatchObject({ status: 'on-track', doneClaimed: false });
    expect((await columns(task.routineId)).task_done_claimed_at).toBeNull();
  });

  it('a claim on a check-in of any other kind records the report and no claim', async () => {
    const task = await f.store.createAuthored(taskInput('task', STAY));
    expect(await record(await bound(task, 'run', minute(1)), needsYouDone, { done: true })).toBe('recorded');
    expect((await f.store.findOne(task))?.task).toMatchObject({ status: 'needs-you', doneClaimed: false });
    expect((await columns(task.routineId)).task_done_claimed_at).toBeNull();
  });

  it('a claim beside any status but needs-you records the report and no claim, even past the contract', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    expect(await record(await bound(task, 'run', minute(1)), onTrack, { done: true })).toBe('recorded');
    expect((await f.store.findOne(task))?.task).toMatchObject({ status: 'on-track', doneClaimed: false });
    expect((await columns(task.routineId)).task_done_claimed_at).toBeNull();
  });

  it('a claim shows only beside the report it came with', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await record(await bound(task, 'run', minute(1)), needsYouDone, { done: true });
    expect((await f.store.findOne(task))?.task?.doneClaimed).toBe(true);
    // A report from code before version 12, after a rollback: a later report time, and the stamp left as it was.
    await sql`UPDATE routines_v1_definitions SET task_reported_at = ${minute(31)} WHERE routine_id = ${task.routineId}`.execute(f.db);
    expect((await f.store.findOne(task))?.task).toMatchObject({ status: 'needs-you', reportedAt: minute(31), doneClaimed: false });
  });

  it('a report on a Done task is refused as done and writes nothing', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    expect(await record(await bound(task, 'run-1', minute(1)), needsYouDone, { done: true })).toBe('recorded');
    const second = await bound(task, 'run-2', minute(2));
    await markDoneByHand(task.routineId);
    const before = await columns(task.routineId);
    expect(await record(second, onTrack, { notes: 'Redirects are next.', steps: [{ op: 'add', text: 'Redirect the old links' }], now: minute(45) }))
      .toBe('done');
    const { rows } = await sql<{ report: unknown }>`SELECT report FROM routines_v1_dispatches WHERE dispatch_id = ${second.dispatchId}`.execute(f.db);
    expect(rows).toEqual([{ report: null }]);
    expect(await f.store.findOne(task)).toMatchObject({
      task: { status: 'needs-you', update: 'Every article is on the new site.', agentNotes: null, reportedAt: minute(30) }, steps: [],
    });
    expect(await columns(task.routineId)).toEqual(before);
  });

  it('a report waiting on the row lock while the task is marked done is refused', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const run = await bound(task, 'run', minute(1));
    // Mark done's own transaction, held open: the routine's row lock, then the write that makes the task Done.
    const held = await openTransaction(trx => lockRow(trx, task), trx => sql`
      UPDATE routines_v1_definitions SET enabled = false, task_completed_at = ${minute(40)}, task_completed_by_user_id = 'owner'
       WHERE routine_id = ${task.routineId}`.execute(trx));
    const waiting = record(run, needsYouDone, { done: true });
    waiting.catch(() => {}); // awaited below, after the hold is let go
    try {
      // The report really waits on the row, so it reads the row only once the task is Done.
      await expect.poll(waitingOnRoutineRow, { timeout: 15_000 }).toBeGreaterThan(0);
    } finally {
      held.release();
      await held.done;
    }
    expect(await waiting).toBe('done');
    expect((await f.store.findOne(task))?.task).toBeNull();
  });

  it('a Done task’s late check-in neither counts a miss nor clears one', async () => {
    const lines = pauseLines();
    // A check-in still running when the task is marked done, that ends in an error without a report.
    const task = await f.store.createAuthored(taskInput('task'));
    const run = await bound(task, 'run', minute(1));
    await markDoneByHand(task.routineId);
    const { revision } = (await f.store.findOne(task))!;
    await finish(run, { status: 'error', error: 'boom', miss: 'failed' });
    expect(await columns(task.routineId)).toMatchObject({ enabled: false, task_misses_in_a_row: 0 });
    expect(await f.store.findOne(task)).toMatchObject({ revision, noRecentUpdate: null, done: { at: minute(40), byUserId: 'owner' } });
    // One that reported before the task was marked done, and ends after: the misses before it stay as they are.
    const other = await f.store.createAuthored(taskInput('other'));
    const reported = await bound(other, 'reported', minute(2));
    expect(await record(reported, onTrack)).toBe('recorded');
    await markDoneByHand(other.routineId);
    await sql`UPDATE routines_v1_definitions SET task_misses_in_a_row = 2, task_miss_reason = 'no-report', task_miss_at = ${minute(0)}
               WHERE routine_id = ${other.routineId}`.execute(f.db);
    await finish(reported);
    expect(await columns(other.routineId)).toMatchObject({ enabled: false, task_misses_in_a_row: 2 });
    expect(lines).toEqual([]);
  });

  it('Done needs the task off, its completer its owner, and a get-done kind', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    // Completed by its owner but running, as code from before version 12 leaves a Done task it resumed: not
    // Done, and its reports land.
    await setCompletion(task.routineId, { enabled: true, by: 'owner' });
    expect((await f.store.findOne(task))?.done).toBeNull();
    expect(await record(await bound(task, 'run', minute(1)), onTrack)).toBe('recorded');
    // Off, but completed by someone who doesn't own it (an owner move by that code): a plain pause.
    await setCompletion(task.routineId, { enabled: false, by: 'someone-else' });
    expect((await f.store.findOne(task))?.done).toBeNull();
    // A time with no one beside it.
    await setCompletion(task.routineId, { enabled: false, by: null });
    expect((await f.store.findOne(task))?.done).toBeNull();
    await setCompletion(task.routineId, { enabled: false, by: 'owner' });
    expect((await f.store.findOne(task))?.done).toEqual({ at: minute(40), byUserId: 'owner' });
    // The same columns on any other kind.
    const stay = await f.store.createAuthored(taskInput('stay', STAY));
    await setCompletion(stay.routineId, { enabled: false, by: 'owner' });
    expect((await f.store.findOne(stay))?.done).toBeNull();
  });

  it('a person’s Resume of a Done task clears its completion and runs it; an edit that keeps it off keeps it Done', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await markDoneByHand(task.routineId);
    const done = { at: minute(40), byUserId: 'owner' };
    const marked = (await f.store.findOne(task))!;
    expect(marked).toMatchObject({ enabled: false, done });
    const described = await edit(marked, 'describe', { description: 'Moving the docs.' });
    expect(described).toMatchObject({ enabled: false, description: 'Moving the docs.', done });
    const resumed = await edit(described, 'resume', { enabled: true });
    expect(resumed).toMatchObject({ enabled: true, done: null, nextRunAt: new Date(now.getTime() + 3_600_000) });
    expect(await columns(task.routineId)).toMatchObject({ enabled: true, task_completed_at: null, task_completed_by_user_id: null });
    expect(await record(await bound(task, 'run', minute(1)), onTrack)).toBe('recorded');
  });

  it('a pause clears a completion left on a running task, a person’s or ax’s', async () => {
    const cleared = { enabled: false, task_completed_at: null, task_completed_by_user_id: null };
    // A person's pause.
    const task = await f.store.createAuthored(taskInput('task'));
    await setCompletion(task.routineId, { enabled: true, by: 'owner' });
    expect(await edit(task, 'pause', { enabled: false })).toMatchObject({ enabled: false, done: null });
    expect(await columns(task.routineId)).toMatchObject(cleared);
    // ax's, at the fifth check-in in a row without a report.
    const lines = pauseLines();
    const other = await f.store.createAuthored(taskInput('other'));
    await setCompletion(other.routineId, { enabled: true, by: 'owner' });
    await sql`UPDATE routines_v1_definitions SET task_misses_in_a_row = ${TASK_AUTO_PAUSE_AFTER_MISSES - 1}, task_miss_reason = 'no-report',
               task_miss_at = ${minute(0)} WHERE routine_id = ${other.routineId}`.execute(f.db);
    await finish(await bound(other, 'fifth', minute(1)));
    expect(lines).toEqual([pausedLine(other.routineId)]);
    expect(await f.store.findOne(other)).toMatchObject({
      enabled: false, done: null, noRecentUpdate: { inARow: TASK_AUTO_PAUSE_AFTER_MISSES, autoPausedAt: expect.any(Date) },
    });
    expect(await columns(other.routineId)).toMatchObject(cleared);
  });

  it('a change of kind or of owner clears the claim and the completion, and leaves the task off', async () => {
    const cleared = { enabled: false, task_done_claimed_at: null, task_completed_at: null, task_completed_by_user_id: null };
    const task = await f.store.createAuthored(taskInput('task'));
    await record(await bound(task, 'run-1', minute(1)), needsYouDone, { done: true });
    await markDoneByHand(task.routineId);
    const marked = (await f.store.findOne(task))!;
    expect(marked).toMatchObject({ task: { doneClaimed: true }, done: { byUserId: 'owner' } });
    const stay = await edit(marked, 'to-stay-on-top', { kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.' });
    expect(stay).toMatchObject({ kind: 'stay-on-top', enabled: false, task: null, done: null });
    expect(await columns(task.routineId)).toMatchObject(cleared);
    // A change of owner (drift repair) clears them too, in the statement that moves the task (TASK-936).
    const other = await f.store.createAuthored(taskInput('other'));
    await record(await bound(other, 'run-2', minute(2)), needsYouDone, { done: true });
    await markDoneByHand(other.routineId);
    expect(await f.store.reconcileOwners({ agents: [{ agentId: 'a', ownerUserId: 'new-owner' }] })).toBe(2);
    expect(await columns(other.routineId)).toMatchObject(cleared);
  });

  it('receipts keep no done, and a replay answers done null', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await markDoneByHand(task.routineId);
    const rename = {
      agentId: 'a', routineId: task.routineId, expectedRevision: task.revision, actorUserId: 'owner', requestId: 'rename',
      patch: { name: 'Move the docs' }, now, stopOnly: false,
    };
    const renamed = await f.store.updateAuthored(rename);
    expect(renamed).toMatchObject({ name: 'Move the docs', enabled: false, done: { at: minute(40), byUserId: 'owner' } });
    const receipts = (await sql<{ operation: string; result: unknown; keyed: boolean }>`
      SELECT operation, result, result ? 'done' AS keyed FROM routines_v1_requests WHERE agent_id = 'a' ORDER BY operation`.execute(f.db)).rows;
    // The key is left out rather than stored as null, so code from before this field still reads every receipt.
    expect(receipts.map(receipt => [receipt.operation, receipt.keyed])).toEqual([['create', false], ['update', false]]);
    const beforeThisField = StoredRoutineSchema.innerType().omit({ done: true });
    for (const { operation, result } of receipts) expect(beforeThisField.safeParse(result).success, operation).toBe(true);
    // An exact replay answers from its receipt: not Done.
    expect(await f.store.updateAuthored(rename)).toEqual({ ...renamed, done: null });
  });
});

describe('Mark done (store, TASK-950)', () => {
  it('marks a get-done task done the way a pause does, and keeps its steps, report and notes', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await setSteps(task.routineId, STEPS);
    await record(await bound(task, 'run', minute(1)), needsYouDone, { done: true, notes: 'Redirects are next.' });
    await setMisses(task.routineId, 2);
    const before = (await f.store.findOne(task))!;
    expect(before).toMatchObject({ enabled: true, steps: STEPS, task: { doneClaimed: true, agentNotes: 'Redirects are next.' }, noRecentUpdate: { inARow: 2 } });
    expect(await complete(task, 'mark-done')).toEqual({ done: true });
    const after = (await f.store.findOne(task))!;
    // Off, at a new revision, with no next run, its misses started over and the claim taken back. The rest stays.
    expect(after).toEqual({
      ...before, enabled: false, revision: expect.any(String), nextRunAt: null, noRecentUpdate: null,
      task: { ...before.task!, doneClaimed: false }, done: { at: minute(50), byUserId: 'owner' },
    });
    expect(after.revision).not.toBe(before.revision);
    expect(await storedRow(task.routineId)).toMatchObject({
      updated_at: minute(50), task_done_claimed_at: null, task_misses_in_a_row: 0, task_miss_reason: null, task_miss_at: null, task_auto_paused_at: null,
    });
    // The hash a person's pause stores: a twin task with the same definition, paused by its person (TASK-930's check).
    const twin = await f.store.createAuthored(taskInput('twin'));
    await edit(twin, 'pause', { enabled: false });
    expect((await storedRow(task.routineId))!.spec_hash).toBe((await storedRow(twin.routineId))!.spec_hash);
    // The tick never claims it, however late it runs. It does claim a task that runs.
    const running = await f.store.createAuthored(taskInput('running'));
    const claimed = await f.store.claimDue({ now: new Date(now.getTime() + 365 * 86_400_000), limit: 10, claimWindowMinutes: 5 });
    expect(claimed.map(row => row.routineId)).toEqual([running.routineId]);
  });

  it('a second Mark done writes nothing, and a retry after a Reopen replays without finishing it again', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    expect(await complete(task, 'A')).toEqual({ done: true });
    const marked = (await storedRow(task.routineId))!;
    // Another press, later: the task is Done already, so the first press's time and revision stand.
    expect(await complete(task, 'B', { now: minute(52) })).toEqual({ done: true });
    expect(await storedRow(task.routineId)).toEqual(marked);
    // The person reopens it, so it runs again.
    expect(await reopened(task, 'C', 'Not yet.')).toMatchObject({ outcome: 'added', wasDone: true, row: { enabled: true, done: null } });
    const running = (await storedRow(task.routineId))!;
    expect(running.revision).not.toBe(marked.revision);
    // The browser retries the first press, its answer lost: the receipt answers, and the task keeps running.
    expect(await complete(task, 'A', { now: minute(60) })).toEqual({ done: true });
    expect(await storedRow(task.routineId)).toEqual(running);
    expect(await f.store.findOne(task)).toMatchObject({ enabled: true, revision: running.revision, done: null });
    // A request id is one press on one task: the same one on another task is refused, never replayed onto it.
    const other = await f.store.createAuthored(taskInput('other'));
    await expect(complete(other, 'A')).rejects.toMatchObject({ toolCode: 'request-conflict', field: 'requestId' });
    expect((await f.store.findOne(other))?.done).toBeNull();
  });

  it('refuses a task it can’t finish, and keeps no receipt', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const stay = await f.store.createAuthored(taskInput('stay', STAY));
    const done = await f.store.createAuthored(taskInput('done'));
    await complete(done, 'mark-done');
    const rows = async () => [await storedRow(task.routineId), await storedRow(stay.routineId), await storedRow(done.routineId)];
    const before = await rows();
    // The Done task's own receipt only.
    expect(await completeReceipts()).toBe(1);
    const refused = async (press: Promise<unknown>, toolCode: string, field: string) => {
      await expect(press).rejects.toMatchObject({ toolCode, field });
      expect(await completeReceipts()).toBe(1);
      expect(await rows()).toEqual(before);
    };
    await refused(complete(stay, 'stay'), 'not-found', 'routineId');
    await refused(complete({ agentId: 'a', routineId: 'rtn_missing' }, 'missing'), 'not-found', 'routineId');
    // Anyone but its owner ('editor' made it), and its owner once they no longer manage the agent's tasks.
    await refused(complete(task, 'editor', { actorUserId: 'editor' }), 'forbidden', 'input');
    await refused(complete(task, 'no-edit', { mayEdit: false }), 'forbidden', 'input');
    // A Done task too: who may press comes before "it's done already", so a new press no one may make never
    // answers as if it worked. (A replay of a request id answers from its receipt, before any check.)
    await refused(complete(done, 'editor-done', { actorUserId: 'editor' }), 'forbidden', 'input');
    await refused(complete(done, 'no-edit-done', { mayEdit: false }), 'forbidden', 'input');
    // The agent fence alone: the agent is retired, though the task's row is still there.
    await sql`INSERT INTO routines_v1_retired_agents (agent_id) VALUES ('a')`.execute(f.db);
    await refused(complete(task, 'retired'), 'not-found', 'routineId');
  });

  it('a Mark done waiting on the row lock while the task is deleted is refused, and keeps no receipt', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    // The delete holds the routine's row lock until it commits, as deleteAuthored does from lockRoutine on.
    const deleting = await openTransaction(trx => lockRow(trx, task),
      trx => trx.deleteFrom('routines_v1_definitions').where('agent_id', '=', 'a').where('routine_id', '=', task.routineId).execute());
    const racing = complete(task, 'mark-done');
    racing.catch(() => {}); // awaited below, after the delete is let go
    try {
      // Mark done really waits on the row. Without this the delete could commit before Mark done reads the
      // row, and a Mark done that never locks it would pass too.
      await expect.poll(waitingOnRoutineRow, { timeout: 15_000 }).toBe(1);
    } finally {
      deleting.release();
      await deleting.done;
    }
    await expect(racing).rejects.toMatchObject({ toolCode: 'not-found', field: 'routineId' });
    expect(await completeReceipts()).toBe(0);
  });

  it('a Mark done waiting on the row lock while the task is edited pauses the edited definition', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    // An edit's own transaction, held open after its write: the routine's row lock, then the new description.
    const editing = await openTransaction(async trx => {
      await lockRow(trx, task);
      await sql`UPDATE routines_v1_definitions SET description = 'Moving the docs.' WHERE routine_id = ${task.routineId}`.execute(trx);
    });
    const racing = complete(task, 'mark-done');
    racing.catch(() => {}); // awaited below, after the edit is let go
    try {
      // Mark done waits on the row, so it reads the definition only once the edit is in.
      await expect.poll(waitingOnRoutineRow, { timeout: 15_000 }).toBe(1);
    } finally {
      editing.release();
      await editing.done;
    }
    expect(await racing).toEqual({ done: true });
    expect(await storedRow(task.routineId)).toMatchObject({ description: 'Moving the docs.', enabled: false });
    // The hash a person's pause of the edited definition stores, not the one from before the edit.
    const edited = await f.store.createAuthored(taskInput('edited'));
    await edit(edited, 'pause-edited', { description: 'Moving the docs.', enabled: false });
    const unedited = await f.store.createAuthored(taskInput('unedited'));
    await edit(unedited, 'pause-unedited', { enabled: false });
    const editedHash = (await storedRow(edited.routineId))!.spec_hash;
    expect(editedHash).not.toBe((await storedRow(unedited.routineId))!.spec_hash);
    expect((await storedRow(task.routineId))!.spec_hash).toBe(editedHash);
  });
});

describe('Not yet and Reopen (store, TASK-950)', () => {
  it('Not yet on a claimed task stores the reply and takes the claim back; the task keeps running', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await record(await bound(task, 'run', minute(1)), needsYouDone, { done: true });
    const claimed = (await storedRow(task.routineId))!;
    // Not yet needs no edit: only reopening a Done task does.
    const notYet = await reopened(task, 'not-yet', 'Also redirect the old links.', { mayEdit: false });
    expect(notYet).toEqual({
      outcome: 'added', replyId: expect.stringMatching(/^reply_/), wasDone: false,
      row: expect.objectContaining({ enabled: true, revision: task.revision, task: expect.objectContaining({ status: 'needs-you', doneClaimed: false }) }),
    });
    // The answer is the routine as it now is.
    expect(notYet.row).toEqual(await f.store.findOne(task));
    // Only the claim moved: the report, the schedule, the revision and the last change stay.
    expect(await storedRow(task.routineId)).toEqual({ ...claimed, task_done_claimed_at: null });
    expect(await f.store.recentReplies({ agentId: 'a', routineId: task.routineId, actorUserId: 'owner', limit: 5 }))
      .toEqual([{ replyId: notYet.replyId, authorUserId: 'owner', text: 'Also redirect the old links.', sentAt: minute(55) }]);
  });

  it('a plain reply on a claimed task answers its ask and leaves the claim: only Not yet or the next report takes it back', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await record(await bound(task, 'run', minute(1)), { ...needsYouDone, ask: 'Should I delete the old pages too?' }, { done: true });
    const claimed = (await storedRow(task.routineId))!;
    const added = await f.store.addReply({
      agentId: 'a', routineId: task.routineId, actorUserId: 'owner', requestId: 'reply', text: 'Keep them for now.', now: minute(55),
    });
    expect(added).toMatchObject({ outcome: 'added' });
    expect((await f.store.findOne(task))?.task).toMatchObject({ status: 'needs-you', doneClaimed: true });
    expect(await storedRow(task.routineId)).toEqual(claimed);
  });

  it('Reopen on a Done task stores the reply and runs the task again', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const runningHash = (await storedRow(task.routineId))!.spec_hash;
    await complete(task, 'mark-done');
    const marked = (await f.store.findOne(task))!;
    // Misses on a Done task come only from code before version 12 (a rollback): a Reopen starts them over, as a Resume does.
    await setMisses(task.routineId, 2);
    const reopenedTask = await reopened(task, 'reopen', 'Also redirect the old links.');
    expect(reopenedTask).toEqual({ outcome: 'added', replyId: expect.stringMatching(/^reply_/), wasDone: true, row: await f.store.findOne(task) });
    expect(reopenedTask.row).toMatchObject({ enabled: true, nextRunAt: new Date(minute(55).getTime() + 3_600_000), done: null, noRecentUpdate: null });
    expect(reopenedTask.row.revision).not.toBe(marked.revision);
    expect(await storedRow(task.routineId)).toMatchObject({
      task_completed_at: null, task_completed_by_user_id: null, task_done_claimed_at: null,
      task_misses_in_a_row: 0, task_miss_reason: null, task_miss_at: null, task_auto_paused_at: null,
      // The running definition's hash, the one it had before Mark done, as a person's Resume stores it.
      spec_hash: runningHash, updated_at: minute(55),
    });
    expect(await storedReplies()).toEqual([{ request_id: 'reopen', body: 'Also redirect the old links.' }]);
  });

  it('Reopen on a Done task needs edit, and stores nothing without it', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await complete(task, 'mark-done');
    const marked = (await storedRow(task.routineId))!;
    expect(await reopen(task, 'reopen', 'Also redirect the old links.', { mayEdit: false })).toBe('forbidden');
    expect(await storedReplies()).toEqual([]);
    expect(await storedRow(task.routineId)).toEqual(marked);
    expect((await f.store.findOne(task))?.done).toEqual({ at: minute(50), byUserId: 'owner' });
    // Decided before the reply would be stored, so a retry of a reply sent before the task was marked done is refused too.
    const other = await f.store.createAuthored(taskInput('other'));
    await reopened(other, 'early', 'Also redirect the old links.');
    await complete(other, 'mark-other-done');
    expect(await reopen(other, 'early', 'Also redirect the old links.', { mayEdit: false })).toBe('forbidden');
    expect((await f.store.findOne(other))?.done).toEqual({ at: minute(50), byUserId: 'owner' });
  });

  it('a retry after the agent claimed again keeps the new claim (seeded interleaving)', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const first = await bound(task, 'run-1', minute(1));
    await record(first, needsYouDone, { done: true, now: minute(2) });
    const notYet = await reopened(task, 'not-yet', 'Also redirect the old links.', { now: minute(3) });
    expect((await f.store.findOne(task))?.task?.doneClaimed).toBe(false);
    // The check-in the Not yet started claims again.
    const second = await bound(task, 'run-2', minute(4));
    await record(second, needsYouDone, { done: true, now: minute(5) });
    // The browser retries the Not yet, its first answer lost: the first reply stands, and so does the new claim.
    expect(await reopen(task, 'not-yet', 'Also redirect the old links.', { now: minute(6) })).toEqual({
      outcome: 'replayed', replyId: notYet.replyId, row: await f.store.findOne(task), wasDone: false,
    });
    expect((await f.store.findOne(task))?.task).toMatchObject({ status: 'needs-you', reportedAt: minute(5), doneClaimed: true });
    expect(await storedReplies()).toEqual([{ request_id: 'not-yet', body: 'Also redirect the old links.' }]);
  });

  it('a claim from a check-in accepted before the Not yet lands, and the one the Not yet started replaces it', async () => {
    // Accepted (decisions row 10): a Not yet doesn't hold against a check-in already running when it's sent. The
    // check-in the Not yet started was accepted after that one, so its report wins whatever order the two finish in.
    const story = async (name: string) => {
      const task = await f.store.createAuthored(taskInput(name));
      await record(await bound(task, `${name}-1`, minute(1)), needsYouDone, { done: true, now: minute(2) });
      const running = await bound(task, `${name}-2`, minute(3));
      await reopened(task, `${name}-not-yet`, 'Also redirect the old links.', { now: minute(4) });
      const started = await bound(task, `${name}-3`, minute(5));
      return { task, running, started };
    };
    // The earlier check-in reports first: its claim lands, and the task reads claimed until the next report.
    const inOrder = await story('in-order');
    await record(inOrder.running, needsYouDone, { done: true, now: minute(6) });
    expect((await f.store.findOne(inOrder.task))?.task).toMatchObject({ status: 'needs-you', doneClaimed: true });
    await record(inOrder.started, onTrack, { now: minute(7) });
    expect((await f.store.findOne(inOrder.task))?.task).toMatchObject({ status: 'on-track', doneClaimed: false });
    // The later one reports first: the earlier one's claim, sent after it, doesn't replace it.
    const reversed = await story('reversed');
    expect(await record(reversed.started, onTrack, { now: minute(6) })).toBe('recorded');
    expect(await record(reversed.running, needsYouDone, { done: true, now: minute(7) })).toBe('recorded');
    expect((await f.store.findOne(reversed.task))?.task).toMatchObject({
      status: 'on-track', update: 'Found two more articles.', reportedAt: minute(6), doneClaimed: false,
    });
  });

  it('a retry of a Reopen after the task was marked done again leaves it done', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await complete(task, 'A');
    const first = await reopened(task, 'R', 'Also redirect the old links.');
    expect(first).toMatchObject({ outcome: 'added', wasDone: true });
    await complete(task, 'B', { now: minute(60) });
    const marked = (await storedRow(task.routineId))!;
    expect(await reopen(task, 'R', 'Also redirect the old links.', { now: minute(65) })).toEqual({
      outcome: 'replayed', replyId: first.replyId, row: await f.store.findOne(task), wasDone: true,
    });
    expect(await storedRow(task.routineId)).toEqual(marked);
    expect((await f.store.findOne(task))?.done).toEqual({ at: minute(60), byUserId: 'owner' });
  });

  it('a reply on a get-done task neither claimed nor Done writes nothing else', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await record(await bound(task, 'run', minute(1)), onTrack);
    const before = (await storedRow(task.routineId))!;
    expect(await reopened(task, 'reply', 'Also redirect the old links.'))
      .toMatchObject({ outcome: 'added', wasDone: false, row: { revision: task.revision, enabled: true } });
    expect(await storedRow(task.routineId)).toEqual(before);
    expect(await storedReplies()).toEqual([{ request_id: 'reply', body: 'Also redirect the old links.' }]);
  });

  it('refuses a stay-on-top task, a missing one and a retired agent as not-found, and anyone but the owner as forbidden', async () => {
    const claimed = await f.store.createAuthored(taskInput('claimed'));
    await record(await bound(claimed, 'run', minute(1)), needsYouDone, { done: true });
    const done = await f.store.createAuthored(taskInput('done'));
    await complete(done, 'mark-done');
    const stay = await f.store.createAuthored(taskInput('stay', STAY));
    const rows = async () => [await storedRow(claimed.routineId), await storedRow(done.routineId), await storedRow(stay.routineId)];
    const before = await rows();
    expect(await reopen(stay, 'stay', 'Hello.')).toBe('not-found');
    // The kind is decided before the owner, as for a reply.
    expect(await reopen(stay, 'stay-stranger', 'Hello.', { actorUserId: 'someone-else' })).toBe('not-found');
    expect(await reopen({ agentId: 'a', routineId: 'rtn_missing' }, 'missing', 'Hello.')).toBe('not-found');
    // 'editor' made both tasks, and 'owner' owns them.
    expect(await reopen(claimed, 'editor', 'Hello.', { actorUserId: 'editor' })).toBe('forbidden');
    expect(await reopen(done, 'editor', 'Hello.', { actorUserId: 'editor' })).toBe('forbidden');
    // The agent fence alone: the agent is retired, though the task's row is still there.
    await sql`INSERT INTO routines_v1_retired_agents (agent_id) VALUES ('a')`.execute(f.db);
    expect(await reopen(claimed, 'retired', 'Hello.')).toBe('not-found');
    expect(await storedReplies()).toEqual([]);
    expect(await rows()).toEqual(before);
  });

  it('a Not yet or a Reopen waiting on the row lock while the task is deleted stores nothing', async () => {
    const claimed = await f.store.createAuthored(taskInput('claimed'));
    await record(await bound(claimed, 'run', minute(1)), needsYouDone, { done: true });
    const done = await f.store.createAuthored(taskInput('done'));
    await complete(done, 'mark-done');
    for (const task of [claimed, done]) {
      // The delete holds the routine's row lock until it commits, as deleteAuthored does from lockRoutine on.
      const deleting = await openTransaction(trx => lockRow(trx, task),
        trx => trx.deleteFrom('routines_v1_definitions').where('agent_id', '=', 'a').where('routine_id', '=', task.routineId).execute());
      const racing = reopen(task, `reply-${task.routineId}`, 'Also redirect the old links.');
      racing.catch(() => {}); // awaited below, after the delete is let go
      try {
        // The press really waits on the row. Without this the delete could commit before it reads the row,
        // and one that never locks it would pass too.
        await expect.poll(waitingOnRoutineRow, { timeout: 15_000 }).toBe(1);
      } finally {
        deleting.release();
        await deleting.done;
      }
      expect(await racing, task.routineId).toBe('not-found');
    }
    expect(await storedReplies()).toEqual([]);
  });
});
