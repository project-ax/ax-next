import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';

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
/** Drift repair's move of every routine of agent 'a' to `ownerUserId`. */
const moveTo = (ownerUserId: string) => f.store.reconcileOwners({ agents: [{ agentId: 'a', ownerUserId }] });
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
});
