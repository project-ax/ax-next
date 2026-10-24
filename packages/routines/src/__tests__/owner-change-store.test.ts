import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { RoutineDefinitionSchema, type RoutineKey } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import type { DispatchReport } from '../types.js';

// TASK-936: an agent's change of owner (reconcileOwners: drift repair, run by the tick and by every
// routines read) starts each of its tasks over. Task 3 adds: a run is read only for whoever it ran as.
const f = fixture();
const minute = (n: number) => new Date(now.getTime() + n * 60_000);
const TASK = RoutineDefinitionSchema.parse({
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
});
/** A task 'owner' owns; each needs its own request id. */
const taskInput = (requestId: string, agentId = 'a') => ({ ...createInput(requestId), agentId, definition: TASK });
const needsYou = { status: 'needs-you', update: 'Refund QX7731 waits on Acme.', ask: 'May I refund QX7731?' } as const;
const onTrack = { status: 'on-track', update: 'Queue is empty.', ask: null } as const;
/** Drift repair's move of every routine of agent 'a' to `ownerUserId`. */
const moveTo = (ownerUserId: string) => f.store.reconcileOwners({ agents: [{ agentId: 'a', ownerUserId }] });
/** A run of the routine at its current revision, asked for by `actorUserId`, bound to its own conversation. */
const bound = async (key: RoutineKey, requestId: string, at: Date, actorUserId = 'owner') => {
  const row = (await f.store.findOne(key))!;
  const { accepted } = (await f.store.acceptDispatch({
    agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId, source: 'manual', requestId, now: at,
  }))!;
  await f.store.bindDispatchConversation({ dispatchId: accepted.dispatchId, conversationId: `c-${requestId}` });
  return { ...accepted, conversationId: `c-${requestId}` };
};
const record = (run: Awaited<ReturnType<typeof bound>>, report: DispatchReport, actorUserId = 'owner', notes?: string) => f.store.recordReport({
  agentId: run.row.agentId, dispatchId: run.dispatchId, conversationId: run.conversationId, actorUserId, report,
  ...(notes === undefined ? {} : { notes }), now: minute(30),
});
const finish = (dispatchId: string) => f.store.finishDispatch({ dispatchId, outcome: { status: 'ok', conversationId: 'c', error: null, renderedPrompt: null, warning: null } });
/** A finished run, with `report` on it, or none when it's null. */
const finished = async (key: RoutineKey, requestId: string, at: Date, report: DispatchReport | null, actorUserId = 'owner') => {
  const run = await bound(key, requestId, at, actorUserId);
  if (report !== null) expect(await record(run, report, actorUserId)).toBe('recorded');
  expect(await finish(run.dispatchId)).toBe(true);
  return run;
};
const stateRow = async (routineId: string) => (await sql<Record<string, unknown>>`
  SELECT owner_user_id, revision, enabled, next_run_at, agent_notes_cleared_at,
         task_status, task_update, task_ask, task_reported_at, task_report_accepted_at, agent_notes,
         task_misses_in_a_row, task_miss_reason, task_miss_at, task_auto_paused_at
    FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0];
/** What NO_TASK_STATE leaves. */
const CLEARED = {
  task_status: null, task_update: null, task_ask: null, task_reported_at: null, task_report_accepted_at: null, agent_notes: null,
  task_misses_in_a_row: 0, task_miss_reason: null, task_miss_at: null, task_auto_paused_at: null,
};

describe('a change of owner (store, TASK-936)', () => {
  it('a change of owner starts every routine it moves over, in the same statement: report, notes and misses go; pause, schedule and notes-cleared time stay', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const repeat = await f.store.createAuthored(createInput('repeat'));
    const other = await f.store.createAuthored(taskInput('other', 'b'));
    // Every routine holds a report, notes, five misses and ax's pause, as recordReport and finishDispatch leave them.
    await sql`UPDATE routines_v1_definitions SET task_status = 'needs-you', task_update = ${needsYou.update}, task_ask = ${needsYou.ask},
      task_reported_at = ${minute(2)}, task_report_accepted_at = ${minute(1)}, agent_notes = 'Acme’s contact is Jo.',
      task_misses_in_a_row = 5, task_miss_reason = 'no-report', task_miss_at = ${minute(3)}, task_auto_paused_at = ${minute(4)},
      enabled = false, agent_notes_cleared_at = ${minute(0)}`.execute(f.db);
    const before = await stateRow(task.routineId);
    const otherBefore = await stateRow(other.routineId);
    expect(await moveTo('new-owner')).toBe(2);
    const after = await stateRow(task.routineId);
    expect(after).toEqual({ ...before, ...CLEARED, owner_user_id: 'new-owner', revision: after?.revision });
    expect(after?.revision).not.toBe(before?.revision);
    // Whatever its kind: a repeat row holding state (a hand edit, a rollback) is cleared too.
    expect(await stateRow(repeat.routineId)).toMatchObject({ ...CLEARED, owner_user_id: 'new-owner' });
    // It reads as a task that never reported, still paused, now a plain pause.
    expect(await f.store.findOne(task)).toMatchObject({ ownerUserId: 'new-owner', enabled: false, task: null, noRecentUpdate: null });
    // Another agent's routine, and the same move again, change nothing.
    expect(await stateRow(other.routineId)).toEqual(otherBefore);
    expect(await moveTo('new-owner')).toBe(0);
    expect(await stateRow(task.routineId)).toEqual(after);
  });

  it('a run records who it ran as when it is accepted, and keeps it when it finishes after a move', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const run = await bound(task, 'open-across-move', minute(1));
    const runAs = async (table: 'routines_v1_dispatches' | 'routines_v1_fires') => (await sql<{ run_as_user_id: string | null }>`
      SELECT run_as_user_id FROM ${sql.table(table)} WHERE dispatch_id = ${run.dispatchId}`.execute(f.db)).rows[0]?.run_as_user_id;
    expect(await runAs('routines_v1_dispatches')).toBe('owner');
    await moveTo('new-owner');
    expect(await finish(run.dispatchId)).toBe(true);
    expect(await runAs('routines_v1_fires')).toBe('owner');
  });

  it('a check-in still open when the task moves leaves the new owner’s task alone: no report, no notes, no miss', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const reported = await bound(task, 'reported', minute(1));
    expect(await record(reported, needsYou, 'owner', 'Acme’s contact is Jo.')).toBe('recorded');
    const silent = await bound(task, 'silent', minute(2));
    await moveTo('new-owner');
    // It can't report into the moved task: recordReport checks the owner under the row lock.
    expect(await record(silent, onTrack)).toBe('owner');
    expect(await finish(silent.dispatchId)).toBe(true);
    expect(await finish(reported.dispatchId)).toBe(true);
    expect(await stateRow(task.routineId)).toMatchObject({ ...CLEARED, owner_user_id: 'new-owner' });
    // Neither run is the new owner's to read, and the earlier owner no longer owns the task.
    expect(await f.store.recentFires(task)).toEqual([]);
    for (const actorUserId of ['new-owner', 'owner']) {
      expect(await f.store.recentReports({ agentId: 'a', routineId: task.routineId, actorUserId, limit: 3 })).toEqual([]);
    }
    // A run with no record of who it ran as (accepted by code from before version 9) still counts, as before.
    const legacy = await bound(task, 'legacy', minute(3), 'new-owner');
    await sql`UPDATE routines_v1_dispatches SET run_as_user_id = NULL WHERE dispatch_id = ${legacy.dispatchId}`.execute(f.db);
    expect(await finish(legacy.dispatchId)).toBe(true);
    expect((await stateRow(task.routineId))?.task_misses_in_a_row).toBe(1);
  });

  it('a routine’s history lists only the runs that ran as its current owner, with that owner, and every run of a routine that’s gone', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await finished(task, 'earlier', minute(1), needsYou);
    await moveTo('new-owner');
    await finished(task, 'newer', minute(2), onTrack, 'new-owner');
    const listed = async () => ({
      byRoutine: (await f.store.recentFires(task)).map(r => [r.firedAt, r.routineOwnerUserId, r.report?.status ?? null]),
      forAgent: (await f.store.recentFiresForAgent({ agentId: 'a' })).map(r => [r.firedAt, r.routineOwnerUserId, r.report?.status ?? null]),
    });
    expect(await listed()).toEqual({ byRoutine: [[minute(2), 'new-owner', 'on-track']], forAgent: [[minute(2), 'new-owner', 'on-track']] });
    // Back to the earlier owner: their own run lists again, the interim owner's doesn't.
    await moveTo('owner');
    expect(await listed()).toEqual({ byRoutine: [[minute(1), 'owner', 'needs-you']], forAgent: [[minute(1), 'owner', 'needs-you']] });
    // A run with no record of who it ran as (written by code from before version 9) lists for no one.
    await sql`INSERT INTO routines_v1_fires (agent_id, routine_id, fired_at, trigger_source, status) VALUES ('a', ${task.routineId}, ${minute(3)}, 'tick', 'ok')`.execute(f.db);
    expect((await listed()).byRoutine).toEqual([[minute(1), 'owner', 'needs-you']]);
    // Once the routine is gone every run of it lists, with no owner, as before (fireViews then shows no report).
    const current = (await f.store.findOne(task))!;
    await f.store.deleteAuthored({ agentId: 'a', routineId: task.routineId, expectedRevision: current.revision, actorUserId: 'owner', requestId: 'delete', now });
    expect((await listed()).byRoutine).toEqual([[minute(3), null, null], [minute(2), null, 'on-track'], [minute(1), null, 'needs-you']]);
  });

  it('a check-in reads only the reports of runs that ran as the person it runs as, on a task they own now', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const reports = (actorUserId: string) => f.store.recentReports({ agentId: 'a', routineId: task.routineId, actorUserId, limit: 3 });
    await finished(task, 'earlier', minute(1), needsYou);
    expect(await reports('owner')).toEqual([{ firedAt: minute(1), report: needsYou }]);
    await moveTo('new-owner');
    expect(await reports('new-owner')).toEqual([]);
    expect(await reports('owner')).toEqual([]);
    await finished(task, 'newer', minute(2), onTrack, 'new-owner');
    expect(await reports('new-owner')).toEqual([{ firedAt: minute(2), report: onTrack }]);
    await moveTo('owner');
    expect(await reports('owner')).toEqual([{ firedAt: minute(1), report: needsYou }]);
    expect(await reports('new-owner')).toEqual([]);
  });
});
