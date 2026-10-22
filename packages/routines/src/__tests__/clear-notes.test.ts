import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import type { AgentContext } from '@ax/core';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { TASK_DEFINITION } from './support/check-in.js';

// TASK-910: `routines:clear-notes`, through the real routines, agents and
// decisions plugins and Postgres. The person clears a task's agent notes on its
// task page. Only the task's owner may: they're the only person the notes are
// shown to, whether or not they still manage the agent's tasks.

let h: RoutineHarness;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); });

const NOTES = 'Order 1234 waits on a refund.';
const createTask = (person: AgentContext, agentId: string) => h.bus.call<unknown, RoutineView>('routines:create', person, {
  agentId, requestId: 'task', definition: RoutineDefinitionSchema.parse(TASK_DEFINITION),
});
/** A report a check-in left, with notes, written straight to the row. */
const withNotes = (routineId: string, notes: string) => sql`
  UPDATE routines_v1_definitions
     SET task_status = 'on-track', task_update = 'Queue is empty.', task_reported_at = '2026-10-09T12:05:00Z',
         task_report_accepted_at = '2026-10-09T12:00:00Z', agent_notes = ${notes}
   WHERE routine_id = ${routineId}`.execute(h.db);
const notesOf = async (routineId: string) => (await sql<{ agent_notes: string | null; agent_notes_cleared_at: Date | null }>`
  SELECT agent_notes, agent_notes_cleared_at FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(h.db)).rows[0];
const key = (view: RoutineView) => ({ agentId: view.agentId, routineId: view.routineId });
const get = (person: AgentContext, view: RoutineView) => h.bus.call<unknown, RoutineView>('routines:get', person, key(view));
const clearNotes = (person: AgentContext, input: { agentId: string; routineId: string }) => h.bus.call<unknown, unknown>('routines:clear-notes', person, input);
const UNTOUCHED = { agent_notes: NOTES, agent_notes_cleared_at: null };

describe('routines:clear-notes (TASK-910)', () => {
  it("the owner clears a task's notes, and its revision and report stay", async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.owner, h.agentId);
    await withNotes(task.routineId, NOTES);
    const before = await get(h.owner, task);
    expect(before.task).toMatchObject({ status: 'on-track', update: 'Queue is empty.', agentNotes: NOTES });
    expect(await clearNotes(h.owner, key(task))).toStrictEqual({ cleared: true });
    // The notes go. The routine, its revision, its report and its ask are as they were.
    expect(await get(h.owner, task)).toEqual({ ...before, task: { ...before.task!, agentNotes: null } });
  });

  it('answers the same when there is nothing left to clear', async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.owner, h.agentId);
    // A task that never reported, then one cleared twice.
    expect(await clearNotes(h.owner, key(task))).toStrictEqual({ cleared: true });
    await withNotes(task.routineId, NOTES);
    expect(await clearNotes(h.owner, key(task))).toStrictEqual({ cleared: true });
    expect(await clearNotes(h.owner, key(task))).toStrictEqual({ cleared: true });
    expect((await get(h.owner, task)).task?.agentNotes).toBeNull();
  });

  it("on a team agent, nobody but the task's owner may clear it", async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.teamAdmin, h.teamAgentId);
    await withNotes(task.routineId, NOTES);
    // Another admin of the team, who manages its tasks, and an ordinary member.
    for (const person of [h.owner, h.teamMember]) {
      await expect(clearNotes(person, key(task)), person.userId).rejects.toMatchObject({ toolCode: 'forbidden' });
    }
    expect(await notesOf(task.routineId)).toEqual(UNTOUCHED);
  });

  it("an owner who no longer manages the agent's tasks can still clear their own task's notes", async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.teamAdmin, h.teamAgentId);
    await withNotes(task.routineId, NOTES);
    await sql`UPDATE routines_v1_definitions SET owner_user_id = 'member' WHERE routine_id = ${task.routineId}`.execute(h.db);
    expect(await h.bus.call('agents:can-manage-routines', h.teamMember, { agentId: h.teamAgentId })).toEqual({ allowed: false });
    // They're shown the notes, with nothing they can change...
    const seen = await get(h.teamMember, task);
    expect(seen.permissions).toEqual({ edit: false, stop: false, fire: false, manageSecret: false });
    expect(seen.task?.agentNotes).toBe(NOTES);
    // ...and they can remove them.
    expect(await clearNotes(h.teamMember, key(task))).toStrictEqual({ cleared: true });
    expect((await notesOf(task.routineId))?.agent_notes).toBeNull();
  });

  it("someone who can't see the agent clears nothing", async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.owner, h.agentId);
    await withNotes(task.routineId, NOTES);
    await expect(clearNotes(h.teamMember, key(task))).rejects.toMatchObject({ code: 'forbidden' });
    expect(await notesOf(task.routineId)).toEqual(UNTOUCHED);
  });

  it("a routine that isn't there is not-found", async () => {
    h = await createRoutineHarness();
    await expect(clearNotes(h.owner, { agentId: h.agentId, routineId: 'rtn_missing' })).rejects.toMatchObject({ toolCode: 'not-found', field: 'routineId' });
  });

  it('leaves one routines_notes_cleared line, with ids only', async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.owner, h.agentId);
    await withNotes(task.routineId, NOTES);
    const info = vi.spyOn(h.owner.logger, 'info');
    expect(await clearNotes(h.owner, key(task))).toStrictEqual({ cleared: true });
    expect(info.mock.calls.filter(([message]) => message === 'routines_notes_cleared'))
      .toEqual([['routines_notes_cleared', { agentId: h.agentId, routineId: task.routineId }]]);
    expect(JSON.stringify(info.mock.calls)).not.toContain(NOTES);
  });
});
