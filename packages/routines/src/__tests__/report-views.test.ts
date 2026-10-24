import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { HookBus, makeAgentContext } from '@ax/core';
import { RoutineDefinitionSchema, type CheckInMiss, type RoutineFireView, type RoutineView } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { registerRoutineServices } from '../services.js';
import { parseStoredRoutine, StoredRoutineSchema } from '../definition.js';
import { AcceptedDispatchSchema } from '../dispatch.js';
import type { DispatchReport, StoredReading } from '../types.js';

// TASK-907: what the reads show of a task's latest report, and of each run's.
// Reports are recorded through the store here, the way `routines:report`
// records them; these tests are about the views.
const f = fixture();
const owner = makeAgentContext({ userId: 'owner', agentId: 'a', sessionId: 's' });
const needsYou = { status: 'needs-you', update: 'Two tickets wait on a refund rule.', ask: 'Can refunds over $50 go out without you?' } as const;
const onTrack = { status: 'on-track', update: 'Queue is empty.', ask: null } as const;
const NOTES = 'Order 1234 waits on a refund.';
const OPEN_5 = { value: 5, label: 'Open tickets' };
const later = new Date(now.getTime() + 60_000);
const taskInput = (requestId: string) => ({ ...createInput(requestId), definition: RoutineDefinitionSchema.parse({
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
}) });

function services(): HookBus {
  const bus = new HookBus();
  bus.registerService('agents:resolve', 'test', async () => ({ agent: { id: 'a', ownerType: 'user', ownerId: 'owner' } }));
  bus.registerService('agents:can-manage-routines', 'test', async () => ({ allowed: true }));
  registerRoutineServices({ bus, store: f.store, now: () => now });
  return bus;
}
const get = (bus: HookBus, routineId: string) => bus.call<unknown, RoutineView>('routines:get', owner, { agentId: 'a', routineId });
const list = async (bus: HookBus) => (await bus.call<unknown, { routines: RoutineView[] }>('routines:list', owner, { agentId: 'a' })).routines;
type Key = { agentId: string; routineId: string; revision: string };
/** A run of `row`, accepted at `at` and bound to its own conversation, that reports `report` (and `reading`, TASK-952) when there is one. */
async function checkIn(row: Key, requestId: string, { at = now, report, notes, reading }: { at?: Date; report?: DispatchReport; notes?: string | null; reading?: StoredReading | null } = {}) {
  const { accepted } = (await f.store.acceptDispatch({
    agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', source: 'manual', requestId, now: at,
  }))!;
  await f.store.bindDispatchConversation({ dispatchId: accepted.dispatchId, conversationId: `c-${requestId}` });
  if (report !== undefined) {
    expect(await f.store.recordReport({
      agentId: row.agentId, dispatchId: accepted.dispatchId, conversationId: `c-${requestId}`, actorUserId: 'owner', report,
      ...(notes === undefined ? {} : { notes }), ...(reading === undefined ? {} : { reading }), now: at,
    })).toBe('recorded');
  }
  return accepted;
}
const finish = async (dispatchId: string) => {
  expect(await f.store.finishDispatch({ dispatchId, outcome: { status: 'ok', conversationId: 'c', error: null, renderedPrompt: 'ran', warning: null } })).toBe(true);
};
const NO_TASK_COLUMNS = {
  task_status: null, task_update: null, task_ask: null, task_reported_at: null, task_report_accepted_at: null, agent_notes: null,
  task_reading_value: null, task_reading_label: null, task_reading_reported_at: null,
};
const taskColumns = async (routineId: string) => (await sql<Record<string, unknown>>`
  SELECT task_status, task_update, task_ask, task_reported_at, task_report_accepted_at, agent_notes,
         task_reading_value, task_reading_label, task_reading_reported_at
    FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0];
/** Due an hour after the row's next run, so `claimDue` takes it. */
const claimed = async (row: { nextRunAt: Date | null }) =>
  f.store.claimDue({ now: new Date(row.nextRunAt!.getTime() + 3_600_000), limit: 10, claimWindowMinutes: 5 });

describe("a task's latest report on the views (TASK-907)", () => {
  it("routines:list and routines:get return a task's latest report and notes", async () => {
    const bus = services();
    const created = await bus.call<unknown, RoutineView>('routines:create', owner, { agentId: 'a', requestId: 'create', definition: taskInput('create').definition });
    expect(created.task).toBeNull();
    await checkIn(created, 'check-in', { report: needsYou, notes: NOTES, reading: OPEN_5 });
    const task = { ...needsYou, reading: OPEN_5, reportedAt: now.toISOString(), agentNotes: NOTES };
    expect((await get(bus, created.routineId)).task).toEqual(task);
    expect((await list(bus)).map(view => view.task)).toEqual([task]);
    // create and update share the view. An edit shows the state and never mints it.
    const edit = { agentId: 'a', routineId: created.routineId, requestId: 'edit', expectedRevision: created.revision, patch: { description: 'Edited.' } };
    const edited = await bus.call<unknown, RoutineView>('routines:update', owner, edit);
    expect(edited.task).toEqual(task);
    // A later check-in moves the task on. Replaying the edit answers from its
    // receipt, which keeps no task state: the edit's answer, with task null.
    // TASK-952: a report that sent no reading shows none, unlike notes it left out.
    await checkIn(edited, 'after-edit', { at: later, report: onTrack });
    expect((await get(bus, created.routineId)).task).toEqual({ ...onTrack, reading: null, reportedAt: later.toISOString(), agentNotes: NOTES });
    expect(await bus.call('routines:update', owner, edit)).toEqual({ ...edited, task: null });
    // The next check-in's dispatch holds the state as acceptDispatch read it,
    // notes included: TASK-908's check-in message takes them from there.
    const next = await f.store.acceptDispatch({ agentId: 'a', routineId: created.routineId, expectedRevision: edited.revision, actorUserId: 'owner', source: 'manual', requestId: 'next', now });
    expect(next?.accepted.row.task).toEqual({ ...onTrack, agentNotes: NOTES, reportedAt: later, reading: null });
  });

  it("receipts keep no copy of a task's state; the live answers keep it", async () => {
    const bus = services();
    const created = await bus.call<unknown, RoutineView>('routines:create', owner, { agentId: 'a', requestId: 'create', definition: taskInput('create').definition });
    await checkIn(created, 'check-in', { report: needsYou, notes: NOTES });
    const edit = { agentId: 'a', routineId: created.routineId, requestId: 'edit', expectedRevision: created.revision, patch: { description: 'Edited.' } };
    const edited = await bus.call<unknown, RoutineView>('routines:update', owner, edit);
    expect(edited.task).toEqual({ ...needsYou, reading: null, reportedAt: now.toISOString(), agentNotes: NOTES });
    // The next check-in's live accept still hands over the state as it read it under the row lock (TASK-908).
    const dispatch = { agentId: 'a', routineId: created.routineId, expectedRevision: edited.revision, actorUserId: 'owner', source: 'manual', requestId: 'next', now } as const;
    const next = await f.store.acceptDispatch(dispatch);
    expect(next?.replayed).toBe(false);
    expect(next?.accepted.row.task).toEqual({ ...needsYou, agentNotes: NOTES, reportedAt: now, reading: null });
    // The receipts (the create, both accepts, the edit) hold none of the agent's text.
    const receipts = (await sql<{ operation: string; result: unknown }>`SELECT operation, result FROM routines_v1_requests WHERE agent_id = 'a' ORDER BY operation, request_id`.execute(f.db)).rows;
    expect(receipts.map(receipt => receipt.operation)).toEqual(['create', 'dispatch', 'dispatch', 'update']);
    for (const text of [NOTES, needsYou.update, needsYou.ask]) expect(JSON.stringify(receipts)).not.toContain(text);
    // They leave the task key out rather than store null, so code from before this field, whose strict
    // schema has no task key, still reads them after a rollback.
    const keyed = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM routines_v1_requests WHERE result ? 'task' OR result->'row' ? 'task'`.execute(f.db)).rows[0];
    expect(keyed?.n).toBe(0);
    const beforeThisField = StoredRoutineSchema.innerType().omit({ task: true });
    for (const { operation, result } of receipts) {
      const routine = operation === 'dispatch' ? (result as { row: unknown }).row : result;
      expect(beforeThisField.safeParse(routine).success, operation).toBe(true);
    }
    // So an exact replay answers with no task state: the receipt's answer, as replays always are, never a fresh read.
    expect(await bus.call('routines:update', owner, edit)).toEqual({ ...edited, task: null });
    const replay = await f.store.acceptDispatch(dispatch);
    expect(replay?.replayed).toBe(true);
    expect(replay?.accepted.row.task).toBeNull();
  });

  it('a repeat routine and a task that never reported have task: null', async () => {
    const bus = services();
    const repeat = await f.store.createAuthored(createInput('repeat'));
    const quiet = await f.store.createAuthored(taskInput('quiet'));
    // A check-in that ends without a report gives the task none.
    await finish((await checkIn(quiet, 'quiet-run')).dispatchId);
    for (const row of [repeat, quiet]) expect((await get(bus, row.routineId)).task).toBeNull();
    expect((await list(bus)).map(view => view.task)).toEqual([null, null]);
    expect((await f.store.findOne(quiet))?.task).toBeNull();
  });

  it("routines:recent-fires and routines:recent-fires-for-agent return each run's report", async () => {
    const bus = services();
    const row = await f.store.createAuthored(taskInput('history'));
    await finish((await checkIn(row, 'reported', { report: needsYou, notes: NOTES, reading: OPEN_5 })).dispatchId);
    await finish((await checkIn(row, 'unread', { at: new Date(now.getTime() + 1000), report: onTrack })).dispatchId);
    await finish((await checkIn(row, 'quiet', { at: new Date(now.getTime() + 2000) })).dispatchId);
    const reported = {
      agentId: 'a', routineId: row.routineId, firedAt: now.toISOString(), triggerSource: 'manual', conversationId: 'c',
      status: 'ok', error: null, renderedPrompt: 'ran', warning: null, report: { ...needsYou, reading: OPEN_5 },
    };
    const forRoutine = await bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires', owner, { agentId: 'a', routineId: row.routineId });
    const forAgent = await bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires-for-agent', owner, { agentId: 'a' });
    for (const { fires } of [forRoutine, forAgent]) {
      // Newest first. The run that didn't report has none, and a run's report never carries the task's notes.
      // TASK-952: each run keeps the reading it sent, and one that sent none shows null.
      expect(fires.map(fire => fire.report)).toEqual([null, { ...onTrack, reading: null }, { ...needsYou, reading: OPEN_5 }]);
      expect(fires[2]).toEqual(reported);
    }
  });

  it('a teammate sees no reading on the task or any run (TASK-952)', async () => {
    const bus = services();
    const teammate = makeAgentContext({ userId: 'teammate', agentId: 'a', sessionId: 's' });
    const row = await f.store.createAuthored(taskInput('shared'));
    await finish((await checkIn(row, 'reported', { report: needsYou, reading: OPEN_5 })).dispatchId);
    const key = { agentId: 'a', routineId: row.routineId };
    async function reads(person: typeof owner) {
      return {
        get: await bus.call<unknown, RoutineView>('routines:get', person, key),
        list: (await bus.call<unknown, { routines: RoutineView[] }>('routines:list', person, { agentId: 'a' })).routines,
        fires: (await bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires', person, key)).fires,
        agentFires: (await bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires-for-agent', person, { agentId: 'a' })).fires,
      };
    }
    // Who can see the routine sees the routine and its run, without the task's state or the run's report.
    const seen = await reads(teammate);
    expect(seen.get).toMatchObject({ routineId: row.routineId, task: null });
    expect(seen.list.map(view => [view.routineId, view.task])).toEqual([[row.routineId, null]]);
    for (const fires of [seen.fires, seen.agentFires]) expect(fires.map(fire => fire.report)).toEqual([null]);
    expect(JSON.stringify(seen)).not.toContain(OPEN_5.label);
    // The owner's same four reads carry it.
    const mine = await reads(owner);
    for (const view of [mine.get, ...mine.list]) expect(view.task?.reading).toEqual(OPEN_5);
    for (const fires of [mine.fires, mine.agentFires]) expect(fires.map(fire => fire.report?.reading)).toEqual([OPEN_5]);
  });

  it('a task turned back into a repeat routine drops its state, and comes back a task with none', async () => {
    const bus = services();
    const row = await f.store.createAuthored(taskInput('convert'));
    await checkIn(row, 'convert-run', { report: needsYou, notes: NOTES, reading: OPEN_5 });
    // TASK-952: its reading goes with the rest of its state.
    expect(await taskColumns(row.routineId)).toMatchObject({ task_reading_value: 5, task_reading_label: 'Open tickets', task_reading_reported_at: now });
    const repeat = await f.store.updateAuthored({
      agentId: 'a', routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner',
      requestId: 'to-repeat', patch: { kind: 'repeat', goodWhen: null }, now, stopOnly: false,
    });
    expect(repeat).toMatchObject({ kind: 'repeat', task: null });
    expect((await get(bus, row.routineId)).task).toBeNull();
    expect(await taskColumns(row.routineId)).toEqual(NO_TASK_COLUMNS);
    const again = await f.store.updateAuthored({
      agentId: 'a', routineId: row.routineId, expectedRevision: repeat.revision, actorUserId: 'owner',
      requestId: 'to-task', patch: { kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.' }, now, stopOnly: false,
    });
    expect(again).toMatchObject({ kind: 'stay-on-top', task: null });
    expect((await get(bus, row.routineId)).task).toBeNull();
    expect((await list(bus)).map(view => view.task)).toEqual([null]);
    // Its next check-in gets no old notes to work from, and a report that leaves
    // notes out keeps none.
    const next = await checkIn(again, 'next', { at: later });
    expect(next.row.task).toBeNull();
    expect(await f.store.recordReport({ agentId: 'a', dispatchId: next.dispatchId, conversationId: 'c-next', actorUserId: 'owner', report: onTrack, now: later })).toBe('recorded');
    expect((await get(bus, row.routineId)).task).toEqual({ ...onTrack, reading: null, reportedAt: later.toISOString(), agentNotes: null });
  });

  it('a routine turned into a task brings no state with it, even state it held as a repeat routine', async () => {
    const bus = services();
    const row = await f.store.createAuthored(createInput('legacy'));
    // A repeat routine holding state: a hand edit, or a row written before kind changes cleared it.
    await f.db.updateTable('routines_v1_definitions').set({
      task_status: 'needs-you', task_update: needsYou.update, task_ask: needsYou.ask, task_reported_at: now, task_report_accepted_at: now, agent_notes: NOTES,
    }).where('routine_id', '=', row.routineId).execute();
    expect((await f.store.findOne(row))?.task).toEqual({ ...needsYou, agentNotes: NOTES, reportedAt: now, reading: null });
    const task = await f.store.updateAuthored({
      agentId: 'a', routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', requestId: 'to-task', now, stopOnly: false,
      patch: { kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.', trigger: { kind: 'interval', every: '15m' } },
    });
    expect(task).toMatchObject({ kind: 'stay-on-top', task: null });
    expect((await get(bus, row.routineId)).task).toBeNull();
    expect(await taskColumns(row.routineId)).toEqual(NO_TASK_COLUMNS);
  });

  it('a receipt written before this PR still replays', async () => {
    const row = await f.store.createAuthored(taskInput('receipt'));
    const { task: _task, ...before } = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
    expect(parseStoredRoutine(before).task).toBeNull();
    expect(AcceptedDispatchSchema.parse({ dispatchId: 'd', reqId: 'q', row: before, source: 'manual', acceptedAt: now.toISOString() }).row.task).toBeNull();
    // The same through the store: receipts whose snapshot has no task key replay as "no report".
    const dispatch = { agentId: 'a', routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', source: 'manual', requestId: 'old-dispatch', now } as const;
    expect(await f.store.acceptDispatch(dispatch)).toMatchObject({ replayed: false });
    await sql`UPDATE routines_v1_requests SET result = result - 'task' WHERE request_id = 'receipt'`.execute(f.db);
    await sql`UPDATE routines_v1_requests SET result = result #- '{row,task}' WHERE request_id = 'old-dispatch'`.execute(f.db);
    const stripped = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM routines_v1_requests WHERE result ? 'task' OR result->'row' ? 'task'`.execute(f.db)).rows[0];
    expect(stripped?.n).toBe(0);
    expect((await f.store.createAuthored(taskInput('receipt'))).task).toBeNull();
    const replay = await f.store.acceptDispatch(dispatch);
    expect(replay).toMatchObject({ replayed: true });
    expect(replay?.accepted.row.task).toBeNull();
  });

  it('a row whose task columns are only partly set reads as never reported', async () => {
    const bus = services();
    const row = await f.store.createAuthored(taskInput('partial'));
    const clear = { task_status: null, task_update: null, task_ask: null, task_reported_at: null, agent_notes: null };
    const partly = [
      { task_status: 'on-track' },
      { task_status: 'on-track', task_update: 'Queue is empty.' },
      { task_update: 'Queue is empty.', task_reported_at: now },
      { task_status: 'off-track', task_reported_at: now, task_ask: 'Any word?', agent_notes: 'Kept notes.' },
    ] as const;
    for (const set of partly) {
      await f.db.updateTable('routines_v1_definitions').set({ ...clear, ...set }).where('routine_id', '=', row.routineId).execute();
      expect((await f.store.findOne(row))?.task, JSON.stringify(set)).toBeNull();
      expect((await f.store.list({ agentId: 'a' })).map(r => r.task), JSON.stringify(set)).toEqual([null]);
      expect((await get(bus, row.routineId)).task, JSON.stringify(set)).toBeNull();
    }
    // The tick parses every due row, so one partly-set row can't stop it for everyone.
    await f.db.updateTable('routines_v1_definitions').set({ ...clear, task_status: 'on-track' }).where('routine_id', '=', row.routineId).execute();
    expect(await claimed(row)).toEqual([expect.objectContaining({ routineId: row.routineId, task: null })]);
  });

  it('a NaN, infinite or half-set reading, or one another report wrote, reads as none, and none of them stops the tick (TASK-952)', async () => {
    const row = await f.store.createAuthored(taskInput('odd-reading'));
    const run = await checkIn(row, 'odd-reading', { report: onTrack, reading: OPEN_5 });
    const task = { ...onTrack, agentNotes: null, reportedAt: now };
    // The reading as recordReport left it, and the row due again, before each case.
    const reset = sql`task_reading_value = 5, task_reading_label = 'Open tickets', task_reading_reported_at = task_reported_at, next_run_at = ${row.nextRunAt}`;
    const odd = {
      'a NaN': sql`task_reading_value = 'NaN'::float8`,
      'an infinity': sql`task_reading_value = 'Infinity'::float8`,
      'no label': sql`task_reading_label = NULL`,
      'an empty label': sql`task_reading_label = ''`,
      // Code from before version 10 (after a rollback) wrote a later report and left the reading columns alone.
      "another report's": sql`task_reading_reported_at = task_reported_at - interval '1 minute'`,
    };
    for (const [label, set] of Object.entries(odd)) {
      await sql`UPDATE routines_v1_definitions SET ${reset} WHERE routine_id = ${row.routineId}`.execute(f.db);
      expect((await f.store.findOne(row))?.task, label).toEqual({ ...task, reading: OPEN_5 });
      await sql`UPDATE routines_v1_definitions SET ${set} WHERE routine_id = ${row.routineId}`.execute(f.db);
      expect((await f.store.findOne(row))?.task, label).toEqual({ ...task, reading: null });
      expect(await claimed(row), label).toEqual([expect.objectContaining({ routineId: row.routineId, task: { ...task, reading: null } })]);
    }
    // A run's reading reads the same way, in its history and in the next check-in's reports.
    await finish(run.dispatchId);
    const fireReport = async () => (await f.store.recentFires(row))[0]?.report;
    const lastReport = async () => (await f.store.recentReports({ agentId: 'a', routineId: row.routineId, actorUserId: 'owner', limit: 1 }))[0]?.report;
    expect(await fireReport()).toEqual({ ...onTrack, reading: OPEN_5 });
    for (const set of [sql`report_reading_value = 'NaN'::float8`, sql`report_reading_label = NULL`]) {
      await sql`UPDATE routines_v1_fires SET report_reading_value = 5, report_reading_label = 'Open tickets' WHERE dispatch_id = ${run.dispatchId}`.execute(f.db);
      await sql`UPDATE routines_v1_fires SET ${set} WHERE dispatch_id = ${run.dispatchId}`.execute(f.db);
      expect(await fireReport()).toEqual({ ...onTrack, reading: null });
      expect(await lastReport()).toEqual({ ...onTrack, reading: null });
    }
  });

  it('a run whose report columns are only partly set shows no report', async () => {
    const bus = services();
    const row = await f.store.createAuthored(taskInput('partial-run'));
    const run = await checkIn(row, 'partial-run');
    await finish(run.dispatchId);
    for (const set of [{ report_status: 'on-track' }, { report_update: 'Queue is empty.', report_ask: 'Any word?' }] as const) {
      await f.db.updateTable('routines_v1_fires').set({ report_status: null, report_update: null, report_ask: null, ...set }).where('dispatch_id', '=', run.dispatchId).execute();
      const { fires } = await bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires', owner, { agentId: 'a', routineId: row.routineId });
      expect(fires.map(fire => fire.report), JSON.stringify(set)).toEqual([null]);
    }
  });

  it("stored text past today's caps still reads, so a later cap can't break a read or the tick", async () => {
    const bus = services();
    const row = await f.store.createAuthored(taskInput('long'));
    const long = { status: 'off-track', update: 'u'.repeat(3000), ask: 'a'.repeat(3000) } as const;
    await finish((await checkIn(row, 'long-run', { report: long, notes: 'n'.repeat(9000) })).dispatchId);
    const task = { ...long, agentNotes: 'n'.repeat(9000) };
    expect((await f.store.findOne(row))?.task).toEqual({ ...task, reportedAt: now, reading: null });
    expect((await get(bus, row.routineId)).task).toEqual({ ...task, reading: null, reportedAt: now.toISOString() });
    const { fires } = await bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires', owner, { agentId: 'a', routineId: row.routineId });
    expect(fires.map(fire => fire.report)).toEqual([{ ...long, reading: null }]);
    expect(await claimed(row)).toEqual([expect.objectContaining({ routineId: row.routineId, task: { ...task, reportedAt: now, reading: null } })]);
  });
});

describe("a task's misses on the views (TASK-930)", () => {
  // The miss columns are set by hand here, as finishDispatch leaves them: these
  // tests are about what the views show of them, not about the counting.
  const teammate = makeAgentContext({ userId: 'teammate', agentId: 'a', sessionId: 's' });
  type Misses = { task_misses_in_a_row: number; task_miss_reason: CheckInMiss; task_miss_at: Date; task_auto_paused_at?: Date | null; enabled?: boolean };
  const setMisses = (routineId: string, set: Misses) =>
    f.db.updateTable('routines_v1_definitions').set(set).where('routine_id', '=', routineId).execute();
  const createTask = (bus: HookBus) =>
    bus.call<unknown, RoutineView>('routines:create', owner, { agentId: 'a', requestId: 'create', definition: taskInput('create').definition });

  it("routines:list and routines:get show a task's misses to its owner, and to no one else", async () => {
    const bus = services();
    const created = await createTask(bus);
    expect(created.noRecentUpdate).toBeNull();
    await setMisses(created.routineId, { task_misses_in_a_row: 2, task_miss_reason: 'no-report', task_miss_at: now });
    const misses = { inARow: 2, reason: 'no-report', at: now.toISOString(), autoPaused: false };
    expect((await get(bus, created.routineId)).noRecentUpdate).toEqual(misses);
    expect((await list(bus)).map(view => view.noRecentUpdate)).toEqual([misses]);
    // Someone else who can see the routine sees the routine, without them.
    const seen = await bus.call<unknown, RoutineView>('routines:get', teammate, { agentId: 'a', routineId: created.routineId });
    expect(seen).toMatchObject({ routineId: created.routineId, noRecentUpdate: null });
    const listed = (await bus.call<unknown, { routines: RoutineView[] }>('routines:list', teammate, { agentId: 'a' })).routines;
    expect(listed.map(view => [view.routineId, view.noRecentUpdate])).toEqual([[created.routineId, null]]);
    // A repeat routine shows none, even when its row holds some.
    const repeat = await f.store.createAuthored(createInput('repeat'));
    await setMisses(repeat.routineId, { task_misses_in_a_row: 2, task_miss_reason: 'failed', task_miss_at: now });
    expect((await get(bus, repeat.routineId)).noRecentUpdate).toBeNull();
  });

  it('autoPaused says ax paused the task, and only while it stays paused', async () => {
    const bus = services();
    const created = await createTask(bus);
    const pausedAt = new Date(now.getTime() + 60_000);
    const fifth = { task_misses_in_a_row: 5, task_miss_reason: 'interrupted', task_miss_at: now, task_auto_paused_at: pausedAt } as const;
    await setMisses(created.routineId, { ...fifth, enabled: false });
    const paused = { inARow: 5, reason: 'interrupted', at: now.toISOString(), autoPaused: true };
    expect(await get(bus, created.routineId)).toMatchObject({ enabled: false, noRecentUpdate: paused });
    expect((await list(bus)).map(view => view.noRecentUpdate)).toEqual([paused]);
    // Running again with the pause time still set (resumed by older code after a rollback, or by hand) isn't paused by ax.
    await setMisses(created.routineId, { ...fifth, enabled: true });
    expect((await get(bus, created.routineId)).noRecentUpdate).toEqual({ ...paused, autoPaused: false });
  });

  it('an exact routines:update replay answers with no misses: a receipt keeps none', async () => {
    const bus = services();
    const created = await createTask(bus);
    await setMisses(created.routineId, { task_misses_in_a_row: 2, task_miss_reason: 'brief-too-long', task_miss_at: now });
    const edit = { agentId: 'a', routineId: created.routineId, requestId: 'edit', expectedRevision: created.revision, patch: { description: 'Edited.' } };
    const edited = await bus.call<unknown, RoutineView>('routines:update', owner, edit);
    expect(edited.noRecentUpdate).toEqual({ inARow: 2, reason: 'brief-too-long', at: now.toISOString(), autoPaused: false });
    expect(await bus.call('routines:update', owner, edit)).toEqual({ ...edited, noRecentUpdate: null });
    // The task itself still has them.
    expect((await get(bus, created.routineId)).noRecentUpdate).toEqual(edited.noRecentUpdate);
  });
});
