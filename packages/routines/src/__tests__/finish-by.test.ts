import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { HookBus, makeAgentContext, type AgentContext, type ToolCall } from '@ax/core';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { TASK_DEFINITION } from './support/check-in.js';
import { createRoutinesStore } from '../store.js';
import { registerRoutineServices } from '../services.js';

// TASK-951: `routines:set-finish-by`, through the real routines, agents and
// decisions plugins and Postgres. A person sets or removes a "get-done" task's
// finish date on its task page. Only the task's owner may, on a get-done task,
// and the routine's revision stays. Neither a tool nor an IPC action, so no
// model can set it: the tools' strict schemas refuse the key.

let h: RoutineHarness;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); });

const GET_DONE = {
  name: 'Move the help center', promptBody: 'Move every help article to the new site.', kind: 'get-done',
  goodWhen: 'Every article is on the new site.', trigger: { kind: 'interval', every: '1h' },
} as const;
const REPEAT = { name: 'Daily', promptBody: 'Check outstanding work.', trigger: { kind: 'interval', every: '1h' } } as const;
const DATE = '2026-11-14';
const createTask = (person: AgentContext, agentId: string, definition: Record<string, unknown> = GET_DONE, requestId = 'task') =>
  h.bus.call<unknown, RoutineView>('routines:create', person, { agentId, requestId, definition: RoutineDefinitionSchema.parse(definition) });
const key = (view: RoutineView) => ({ agentId: view.agentId, routineId: view.routineId });
const get = (person: AgentContext, view: RoutineView) => h.bus.call<unknown, RoutineView>('routines:get', person, key(view));
const listed = async (person: AgentContext, view: RoutineView) => (await h.bus.call<unknown, { routines: RoutineView[] }>(
  'routines:list', person, { agentId: view.agentId })).routines.find(row => row.routineId === view.routineId);
const setFinishBy = (person: AgentContext, input: Record<string, unknown>) => h.bus.call<unknown, unknown>('routines:set-finish-by', person, input);
const finishByOf = async (routineId: string) => (await sql<{ finish_by: string | null }>`
  SELECT finish_by FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(h.db)).rows[0]?.finish_by;
/** TASK-955. The time zone stored beside the date. */
const zoneOf = async (routineId: string) => (await sql<{ finish_by_time_zone: string | null }>`
  SELECT finish_by_time_zone FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(h.db)).rows[0]?.finish_by_time_zone;
/** A report and a step, written straight to the row, so the task has state only its owner is shown. */
const withState = (routineId: string) => sql`
  UPDATE routines_v1_definitions
     SET task_status = 'on-track', task_update = 'Half the articles are across.', task_reported_at = '2026-10-09T12:05:00Z',
         task_report_accepted_at = '2026-10-09T12:00:00Z',
         task_steps = ${JSON.stringify([{ id: 's000001', text: 'Export every article', done: true, addedBy: 'agent' }])}::jsonb
   WHERE routine_id = ${routineId}`.execute(h.db);

describe('routines:set-finish-by (TASK-951)', () => {
  it("the owner sets a get-done task's finish date and removes it; its revision stays", async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.owner, h.agentId);
    expect([task.finishBy, task.finishByTimeZone]).toEqual([null, null]);
    const before = await get(h.owner, task);
    expect(before.revision).toBe(task.revision);
    expect(await setFinishBy(h.owner, { ...key(task), finishBy: DATE, finishByTimeZone: 'America/Los_Angeles' }))
      .toStrictEqual({ finishBy: DATE, finishByTimeZone: 'America/Los_Angeles' });
    // The date and the zone it was set from show (TASK-955), and nothing else on the routine moved, its revision included.
    expect(await get(h.owner, task)).toEqual({ ...before, finishBy: DATE, finishByTimeZone: 'America/Los_Angeles' });
    expect(await listed(h.owner, task)).toMatchObject({ finishBy: DATE, finishByTimeZone: 'America/Los_Angeles' });
    expect(await setFinishBy(h.owner, { ...key(task), finishBy: null })).toStrictEqual({ finishBy: null, finishByTimeZone: null });
    expect(await get(h.owner, task)).toEqual(before);
    expect(await finishByOf(task.routineId)).toBeNull();
  });

  it('setting the same date twice answers the same and keeps the revision', async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.owner, h.agentId);
    // A save whose answer was lost, pressed again: the same value set twice is the same write.
    for (const finishBy of [DATE, DATE, null, null]) {
      expect(await setFinishBy(h.owner, { ...key(task), finishBy }), String(finishBy)).toStrictEqual({ finishBy, finishByTimeZone: null });
    }
    expect(await setFinishBy(h.owner, { ...key(task), finishBy: DATE })).toStrictEqual({ finishBy: DATE, finishByTimeZone: null });
    expect(await get(h.owner, task)).toMatchObject({ finishBy: DATE, revision: task.revision });
  });

  it("on a team agent the date shows to whoever sees the task, and nobody but its owner may set it", async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.teamAdmin, h.teamAgentId);
    await withState(task.routineId);
    const dated = { finishBy: DATE, finishByTimeZone: 'America/Los_Angeles' };
    expect(await setFinishBy(h.teamAdmin, { ...key(task), ...dated })).toStrictEqual(dated);
    // Its owner sees the date and the zone it was set from beside the task's state...
    expect(await get(h.teamAdmin, task)).toMatchObject({ ...dated, task: { status: 'on-track' }, steps: [{ id: 's000001' }] });
    // ...and so does anyone else who sees the task, without that state: the date is about the work, and holds no agent text,
    // and so is its zone (TASK-955). Another admin of the team, who manages its tasks, and an ordinary member.
    for (const person of [h.owner, h.teamMember]) {
      expect(await get(person, task), person.userId).toMatchObject({ ...dated, task: null, steps: [] });
      expect(await listed(person, task), person.userId).toMatchObject(dated);
      for (const finishBy of ['2030-01-01', null]) {
        await expect(setFinishBy(person, { ...key(task), finishBy }), `${person.userId} ${finishBy}`).rejects.toMatchObject({ toolCode: 'forbidden' });
      }
    }
    expect(await finishByOf(task.routineId)).toBe(DATE);
  });

  it("an owner who no longer manages the agent's tasks can still set their own task's date", async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.teamAdmin, h.teamAgentId);
    await sql`UPDATE routines_v1_definitions SET owner_user_id = 'member' WHERE routine_id = ${task.routineId}`.execute(h.db);
    // Current members now manage their own work. Keep the independent read-only
    // policy contract explicit rather than using membership to stand in for it.
    const bus = new HookBus();
    bus.registerService('agents:resolve', 'test', (ctx, input) => h.bus.call('agents:resolve', ctx, input));
    bus.registerService('agents:can-manage-routines', 'test', async () => ({ allowed: false, stopOthers: false }));
    registerRoutineServices({ bus, store: createRoutinesStore(h.db), now: () => new Date() });
    expect(await bus.call('agents:can-manage-routines', h.teamMember, { agentId: h.teamAgentId })).toEqual({ allowed: false, stopOthers: false });
    // They can change nothing else on it...
    expect((await bus.call<unknown, RoutineView>('routines:get', h.teamMember, key(task))).permissions).toEqual({ edit: false, stop: false, fire: false, manageSecret: false });
    // ...and they can set its date: it changes only how the agent words its status, so it adds no reach.
    expect(await bus.call('routines:set-finish-by', h.teamMember, { ...key(task), finishBy: DATE })).toStrictEqual({ finishBy: DATE, finishByTimeZone: null });
    expect((await bus.call<unknown, RoutineView>('routines:get', h.teamMember, key(task))).finishBy).toBe(DATE);
    expect(await finishByOf(task.routineId)).toBe(DATE);
  });

  it("someone who can't see the agent sets nothing", async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.owner, h.agentId);
    await expect(setFinishBy(h.teamMember, { ...key(task), finishBy: DATE })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await finishByOf(task.routineId)).toBeNull();
  });

  it("a routine that isn't there, a stay-on-top task and a repeat routine are not-found", async () => {
    h = await createRoutineHarness();
    const stayOnTop = await createTask(h.owner, h.agentId, TASK_DEFINITION, 'stay-on-top');
    const repeat = await createTask(h.owner, h.agentId, REPEAT, 'repeat');
    for (const input of [{ agentId: h.agentId, routineId: 'rtn_missing' }, key(stayOnTop), key(repeat)]) {
      await expect(setFinishBy(h.owner, { ...input, finishBy: DATE }), input.routineId).rejects.toMatchObject({ toolCode: 'not-found', field: 'routineId' });
    }
    for (const view of [stayOnTop, repeat]) expect(await finishByOf(view.routineId), view.name).toBeNull();
  });

  it("a date that isn't real, or a key the service doesn't take, is refused before anything is written", async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.owner, h.agentId);
    const callJoined = vi.spyOn(h.bus, 'callJoined');
    const resolves = () => callJoined.mock.calls.filter(([hook]) => hook === 'agents:resolve').length;
    for (const input of [{ ...key(task), finishBy: '2026-02-30' }, { ...key(task), finishBy: '26-11-14' }, { ...key(task), finishBy: DATE, note: 'x' }]) {
      await expect(setFinishBy(h.owner, input), JSON.stringify(input)).rejects.toMatchObject({ toolCode: 'validation' });
    }
    // Refused before the agent was even looked up...
    expect(resolves()).toBe(0);
    expect(await finishByOf(task.routineId)).toBeNull();
    // ...where a real date is looked up, then written.
    expect(await setFinishBy(h.owner, { ...key(task), finishBy: DATE })).toStrictEqual({ finishBy: DATE, finishByTimeZone: null });
    expect(resolves()).toBeGreaterThan(0);
  });

  it("a stay-on-top task's view shows no date, and no zone, even when its row holds them", async () => {
    h = await createRoutineHarness();
    const stayOnTop = await createTask(h.owner, h.agentId, TASK_DEFINITION, 'stay-on-top');
    // A hand edit, or a kind change made by code from before version 12, which cleared neither the date nor (TASK-955)
    // the zone stored beside it.
    await sql`UPDATE routines_v1_definitions SET finish_by = ${DATE}, finish_by_time_zone = 'America/Los_Angeles'
               WHERE routine_id = ${stayOnTop.routineId}`.execute(h.db);
    expect(await get(h.owner, stayOnTop)).toMatchObject({ finishBy: null, finishByTimeZone: null });
    expect(await listed(h.owner, stayOnTop)).toMatchObject({ finishBy: null, finishByTimeZone: null });
  });

  it('leaves one routines_finish_by_set line, with ids and whether it cleared', async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.owner, h.agentId);
    const info = vi.spyOn(h.owner.logger, 'info');
    expect(await setFinishBy(h.owner, { ...key(task), finishBy: DATE, finishByTimeZone: 'America/Los_Angeles' }))
      .toStrictEqual({ finishBy: DATE, finishByTimeZone: 'America/Los_Angeles' });
    expect(await setFinishBy(h.owner, { ...key(task), finishBy: null })).toStrictEqual({ finishBy: null, finishByTimeZone: null });
    expect(info.mock.calls.filter(([message]) => message === 'routines_finish_by_set')).toEqual([
      ['routines_finish_by_set', { agentId: h.agentId, routineId: task.routineId, cleared: false }],
      ['routines_finish_by_set', { agentId: h.agentId, routineId: task.routineId, cleared: true }],
    ]);
    // Ids and a flag only: never the date, and never the zone it was set from (TASK-955).
    expect(JSON.stringify(info.mock.calls)).not.toContain(DATE);
    expect(JSON.stringify(info.mock.calls)).not.toContain('Los_Angeles');
  });

  it('the owner sets a date with the zone it was set from; the answer and the row carry it (TASK-955)', async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.owner, h.agentId);
    expect(await setFinishBy(h.owner, { ...key(task), finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' }))
      .toStrictEqual({ finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' });
    expect(await zoneOf(task.routineId)).toBe('America/Los_Angeles');
    expect(await finishByOf(task.routineId)).toBe('2026-10-25');
    // Like the date, the zone never moves the revision.
    expect((await get(h.owner, task)).revision).toBe(task.revision);
  });

  it("a zone that isn't one is refused before anything is written (TASK-955)", async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.owner, h.agentId);
    const callJoined = vi.spyOn(h.bus, 'callJoined');
    const resolves = () => callJoined.mock.calls.filter(([hook]) => hook === 'agents:resolve').length;
    // No calendar has the first; the second is what a browser that can't tell its zone reports; then an empty name and
    // one past the 256-character cap.
    for (const finishByTimeZone of ['Not/AZone', 'Etc/Unknown', '', 'x'.repeat(257)]) {
      await expect(setFinishBy(h.owner, { ...key(task), finishBy: DATE, finishByTimeZone }), JSON.stringify(finishByTimeZone))
        .rejects.toMatchObject({ toolCode: 'validation' });
    }
    // Refused before the agent was even looked up, and neither column was written...
    expect(resolves()).toBe(0);
    expect(await finishByOf(task.routineId)).toBeNull();
    expect(await zoneOf(task.routineId)).toBeNull();
    // ...where a real zone is looked up, then written beside the date.
    expect(await setFinishBy(h.owner, { ...key(task), finishBy: DATE, finishByTimeZone: 'Asia/Tokyo' }))
      .toStrictEqual({ finishBy: DATE, finishByTimeZone: 'Asia/Tokyo' });
    expect(resolves()).toBeGreaterThan(0);
  });

  it('routine_update and routine_create with a finishBy key are refused at pre-call and at execute, and the date stays', async () => {
    h = await createRoutineHarness();
    const task = await createTask(h.owner, h.agentId);
    expect(await setFinishBy(h.owner, { ...key(task), finishBy: DATE })).toStrictEqual({ finishBy: DATE, finishByTimeZone: null });
    const chat = makeAgentContext({ ...h.owner, agentId: h.agentId, conversationId: 'chat' });
    const decisions = async () => (await h.bus.call<unknown, { decisions: unknown[] }>('decisions:list', chat, { userId: chat.userId })).decisions;
    const routineIds = async () => (await h.bus.call<unknown, { routines: RoutineView[] }>('routines:list', h.owner, { agentId: h.agentId }))
      .routines.map(row => row.routineId);
    const held = await decisions();
    const routines = await routineIds();
    const update: ToolCall = { id: 'edit', name: 'routine_update', input: {
      requestId: 'edit', routineId: task.routineId, expectedRevision: (await get(h.owner, task)).revision, patch: { finishBy: '2030-01-01' } } };
    const create: ToolCall = { id: 'create', name: 'routine_create', input: {
      requestId: 'create', definition: { ...GET_DONE, finishBy: '2030-01-01' } } };
    for (const call of [update, create]) {
      // Refused, not held: no card ever offers the person a date an agent wrote.
      expect(await h.bus.fire('tool:pre-call', chat, call), call.name).toMatchObject({ rejected: true });
      // And refused at execute, so no path that skips tool:pre-call can set it either.
      await expect(h.bus.call(`tool:execute:${call.name}`, chat, call), call.name).rejects.toMatchObject({ toolCode: 'validation' });
    }
    // The date is still the person's, no routine was made, and nothing waits on the person.
    expect(await finishByOf(task.routineId)).toBe(DATE);
    expect(await routineIds()).toEqual(routines);
    expect(await decisions()).toEqual(held);
  });
});
