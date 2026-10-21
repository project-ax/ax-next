import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { HookBus, makeAgentContext } from '@ax/core';
import { RoutineDefinitionSchema, type RoutineFireView, type RoutineView } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { registerRoutineServices } from '../services.js';
import { parseStoredRoutine } from '../definition.js';
import { AcceptedDispatchSchema } from '../dispatch.js';
import type { DispatchReport } from '../types.js';

// TASK-907: what the reads show of a task's latest report, and of each run's.
// Reports are recorded through the store here, the way `routines:report`
// records them; these tests are about the views.
const f = fixture();
const owner = makeAgentContext({ userId: 'owner', agentId: 'a', sessionId: 's' });
const needsYou = { status: 'needs-you', update: 'Two tickets wait on a refund rule.', ask: 'Can refunds over $50 go out without you?' } as const;
const NOTES = 'Order 1234 waits on a refund.';
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
/** A run of `row`, accepted at `at` and bound to its own conversation, that reports `report` when there is one. */
async function checkIn(row: Key, requestId: string, { at = now, report, notes }: { at?: Date; report?: DispatchReport; notes?: string | null } = {}) {
  const { accepted } = (await f.store.acceptDispatch({
    agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', source: 'manual', requestId, now: at,
  }))!;
  await f.store.bindDispatchConversation({ dispatchId: accepted.dispatchId, conversationId: `c-${requestId}` });
  if (report !== undefined) {
    expect(await f.store.recordReport({ agentId: row.agentId, dispatchId: accepted.dispatchId, actorUserId: 'owner', report, ...(notes === undefined ? {} : { notes }), now: at })).toBe(true);
  }
  return accepted;
}
const finish = async (dispatchId: string) => {
  expect(await f.store.finishDispatch({ dispatchId, outcome: { status: 'ok', conversationId: 'c', error: null, renderedPrompt: 'ran', warning: null } })).toBe(true);
};
/** Due an hour after the row's next run, so `claimDue` takes it. */
const claimed = async (row: { nextRunAt: Date | null }) =>
  f.store.claimDue({ now: new Date(row.nextRunAt!.getTime() + 3_600_000), limit: 10, claimWindowMinutes: 5 });

describe("a task's latest report on the views (TASK-907)", () => {
  it("routines:list and routines:get return a task's latest report and notes", async () => {
    const bus = services();
    const created = await bus.call<unknown, RoutineView>('routines:create', owner, { agentId: 'a', requestId: 'create', definition: taskInput('create').definition });
    expect(created.task).toBeNull();
    await checkIn(created, 'check-in', { report: needsYou, notes: NOTES });
    const task = { ...needsYou, reportedAt: now.toISOString(), notes: NOTES };
    expect((await get(bus, created.routineId)).task).toEqual(task);
    expect((await list(bus)).map(view => view.task)).toEqual([task]);
    // create and update share the view. An edit shows the state and never
    // mints it, and replaying the same edit shows what it showed the first time.
    const edit = { agentId: 'a', routineId: created.routineId, requestId: 'edit', expectedRevision: created.revision, patch: { description: 'Edited.' } };
    const edited = await bus.call<unknown, RoutineView>('routines:update', owner, edit);
    expect(edited.task).toEqual(task);
    expect(await bus.call('routines:update', owner, edit)).toEqual(edited);
    // The next check-in's dispatch holds the state as acceptDispatch read it,
    // notes included: TASK-908's check-in message takes them from there.
    const next = await f.store.acceptDispatch({ agentId: 'a', routineId: created.routineId, expectedRevision: edited.revision, actorUserId: 'owner', source: 'manual', requestId: 'next', now });
    expect(next?.accepted.row.task).toEqual({ ...needsYou, notes: NOTES, reportedAt: now });
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
    await finish((await checkIn(row, 'reported', { report: needsYou, notes: NOTES })).dispatchId);
    await finish((await checkIn(row, 'quiet', { at: new Date(now.getTime() + 1000) })).dispatchId);
    const reported = {
      agentId: 'a', routineId: row.routineId, firedAt: now.toISOString(), triggerSource: 'manual', conversationId: 'c',
      status: 'ok', error: null, renderedPrompt: 'ran', warning: null, report: needsYou,
    };
    const forRoutine = await bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires', owner, { agentId: 'a', routineId: row.routineId });
    const forAgent = await bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires-for-agent', owner, { agentId: 'a' });
    for (const { fires } of [forRoutine, forAgent]) {
      // Newest first. The run that didn't report has none, and a run's report never carries the task's notes.
      expect(fires.map(fire => fire.report)).toEqual([null, needsYou]);
      expect(fires[1]).toEqual(reported);
    }
  });

  it('a task turned back into a repeat routine hides its old state', async () => {
    const bus = services();
    const row = await f.store.createAuthored(taskInput('convert'));
    await checkIn(row, 'convert-run', { report: needsYou, notes: NOTES });
    const repeat = await f.store.updateAuthored({
      agentId: 'a', routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner',
      requestId: 'to-repeat', patch: { kind: 'repeat', goodWhen: null }, now, stopOnly: false,
    });
    expect(repeat.kind).toBe('repeat');
    expect((await get(bus, row.routineId)).task).toBeNull();
    expect((await list(bus)).map(view => view.task)).toEqual([null]);
    // The store keeps it; only the view hides it.
    expect((await f.store.findOne(row))?.task).toEqual({ ...needsYou, notes: NOTES, reportedAt: now });
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
    const task = { ...long, notes: 'n'.repeat(9000) };
    expect((await f.store.findOne(row))?.task).toEqual({ ...task, reportedAt: now });
    expect((await get(bus, row.routineId)).task).toEqual({ ...task, reportedAt: now.toISOString() });
    const { fires } = await bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires', owner, { agentId: 'a', routineId: row.routineId });
    expect(fires.map(fire => fire.report)).toEqual([long]);
    expect(await claimed(row)).toEqual([expect.objectContaining({ routineId: row.routineId, task: { ...task, reportedAt: now } })]);
  });
});
