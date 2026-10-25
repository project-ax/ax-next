import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { editableDefinition, ROUTINE_DEFINITION_MAX_BYTES, RoutineDefinitionSchema, type RoutineDefinition, type RoutineKey } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import type { StoredStep } from '../types.js';

// TASK-953: a person's copy of their own task, as the store makes it (duplicateAuthored). Under one receipt, so a
// copy never exists without its steps and the same request again answers the same copy. Owner only, decided under
// the agent fence and the request's row, with the source read FOR SHARE. The copy is paused and carries the source's
// definition but its name, and its steps unticked; none of the task's state, replies or runs. The columns a copy
// must leave behind aren't all on StoredRoutine, so they're read with SQL.
const f = fixture();
const minute = (n: number) => new Date(now.getTime() + n * 60_000);
const GET_DONE = RoutineDefinitionSchema.parse({
  name: 'Move the help docs', promptBody: 'Move our help docs to the new site.', trigger: { kind: 'interval', every: '1h' },
  kind: 'get-done', goodWhen: 'Every article is on the new site.',
});
const STAY_ON_TOP = RoutineDefinitionSchema.parse({
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
});
const step = (id: string, text: string, done: boolean, addedBy: StoredStep['addedBy']): StoredStep => ({ id, text, done, addedBy });
/** A task 'owner' owns ('editor' made it). Each create needs its own request id: createInput's default would replay. */
const createTask = (requestId: string, definition: RoutineDefinition = GET_DONE) => f.store.createAuthored({ ...createInput(requestId), definition });
/**
 * A person's copy of a task, as its owner unless `actorUserId` says otherwise; the copy is 'owner's. Async, so even a
 * missing method rejects rather than throws.
 */
const duplicate = async (key: RoutineKey, requestId: string, actorUserId = 'owner') =>
  f.store.duplicateAuthored({ agentId: key.agentId, routineId: key.routineId, actorUserId, ownerUserId: 'owner', requestId, now: minute(5) });
/** duplicateAuthored's answer when it made or replayed a copy; a refusal fails the test. */
const copied = async (...args: Parameters<typeof duplicate>) => {
  const result = await duplicate(...args);
  if (typeof result === 'string') throw new Error(`duplicateAuthored answered ${result}`);
  return result;
};
/** Every column of a routine's row. */
const rowOf = async (routineId: string) => (await sql<Record<string, unknown>>`
  SELECT * FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0];
const definitionRows = async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM routines_v1_definitions`.execute(f.db)).rows[0]!.n;
/** Every receipt a copy left. */
const receipts = async () => (await sql<{ operation: string; request_id: string; result: unknown }>`
  SELECT operation, request_id, result FROM routines_v1_requests WHERE operation = 'duplicate' ORDER BY request_id`.execute(f.db)).rows;
/** `task_steps` written by hand (the agent's report, a rollback, a later version). */
const writeSteps = (routineId: string, value: unknown) =>
  sql`UPDATE routines_v1_definitions SET task_steps = ${JSON.stringify(value)}::jsonb WHERE routine_id = ${routineId}`.execute(f.db);
/** How many rows of `table` belong to the routine. */
const rowsFor = async (table: 'routines_v1_replies' | 'routines_v1_fires' | 'routines_v1_dispatches', routineId: string) =>
  (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)} WHERE routine_id = ${routineId}`.execute(f.db)).rows[0]!.n;

describe("a person's copy of their task (store, TASK-953)", () => {
  it('copies a get-done task paused, with the same definition but its name, and its steps unticked under new ids', async () => {
    const task = await createTask('task', {
      ...GET_DONE, description: 'The help center move.', activeHours: { start: '09:00', end: '17:00', tz: 'Europe/Berlin' },
    });
    await writeSteps(task.routineId, [step('s000001', 'Export every article', true, 'agent'), step('s000002', 'Ask Dana to review billing', false, 'person')]);
    const source = (await f.store.findOne(task))!;
    const { routineId } = await copied(task, 'd1');
    expect(routineId).toMatch(/^rtn_/);
    expect(routineId).not.toBe(task.routineId);
    const copy = (await f.store.findOne({ agentId: 'a', routineId }))!;
    expect(editableDefinition(copy)).toEqual({ ...editableDefinition(source), name: 'Copy of Move the help docs', enabled: false });
    expect(copy).toMatchObject({ nextRunAt: null, ownerUserId: 'owner', definitionId: null });
    expect(copy.revision).not.toBe(source.revision);
    expect(copy.steps).toEqual([
      { id: expect.stringMatching(/^s[0-9a-z]{6}$/), text: 'Export every article', done: false, addedBy: 'agent' },
      { id: expect.stringMatching(/^s[0-9a-z]{6}$/), text: 'Ask Dana to review billing', done: false, addedBy: 'person' },
    ]);
    expect(copy.steps.map(entry => entry.id)).not.toContain('s000001');
    expect(copy.steps.map(entry => entry.id)).not.toContain('s000002');
    expect(await rowOf(routineId)).toMatchObject({ created_at: minute(5), updated_at: minute(5) });
    // The source reads exactly as before.
    expect(await f.store.findOne(task)).toEqual(source);
  });

  it('copies a stay-on-top task too', async () => {
    const task = await createTask('task', STAY_ON_TOP);
    const { routineId } = await copied(task, 'd1');
    expect(await f.store.findOne({ agentId: 'a', routineId })).toMatchObject({ kind: 'stay-on-top', name: 'Copy of Support queue', enabled: false, steps: [] });
  });

  it('the copy is owned by the owner the caller names, as routines:create’s routine is', async () => {
    const task = await createTask('task');
    const result = await f.store.duplicateAuthored({
      agentId: 'a', routineId: task.routineId, actorUserId: 'owner', ownerUserId: 'agent-owner', requestId: 'd1', now: minute(5),
    });
    if (typeof result === 'string') throw new Error(`duplicateAuthored answered ${result}`);
    expect((await f.store.findOne({ agentId: 'a', routineId: result.routineId }))?.ownerUserId).toBe('agent-owner');
  });

  it('copies none of the task’s state, replies or history', async () => {
    const task = await createTask('task');
    expect(await f.store.setFinishBy({ agentId: 'a', routineId: task.routineId, actorUserId: 'owner', finishBy: '2026-11-14' })).toEqual({ finishBy: '2026-11-14' });
    expect(await f.store.addReply({ agentId: 'a', routineId: task.routineId, actorUserId: 'owner', requestId: 'reply', text: 'Use the code QX7731.', now: minute(1) }))
      .toMatchObject({ outcome: 'added' });
    const run = await f.store.acceptDispatch({
      agentId: 'a', routineId: task.routineId, expectedRevision: task.revision, actorUserId: 'owner', source: 'manual', requestId: 'run', now: minute(2),
    });
    expect(await f.store.finishDispatch({
      dispatchId: run!.accepted.dispatchId, outcome: { status: 'ok', conversationId: 'c', error: null, renderedPrompt: null, warning: null },
    })).toBe(true);
    // Everything a task's reports, runs and pauses leave on its row, at once.
    await sql`UPDATE routines_v1_definitions SET task_status = 'needs-you', task_update = 'Refund QX7731 waits on Acme.', task_ask = 'May I refund QX7731?',
      task_reported_at = ${minute(3)}, task_report_accepted_at = ${minute(2)}, agent_notes = 'The refund code is QX7731.', agent_notes_cleared_at = ${minute(1)},
      task_reading_value = 3, task_reading_label = 'Open tickets', task_reading_reported_at = ${minute(3)},
      task_misses_in_a_row = 2, task_miss_reason = 'no-report', task_miss_at = ${minute(4)}, task_auto_paused_at = ${minute(4)},
      last_run_at = ${minute(2)}, last_status = 'error', last_error = 'boom', last_warning = 'warned'
      WHERE routine_id = ${task.routineId}`.execute(f.db);
    expect(await f.store.findOne(task)).toMatchObject({
      finishBy: '2026-11-14', task: { status: 'needs-you', agentNotes: 'The refund code is QX7731.' }, noRecentUpdate: { inARow: 2 }, lastStatus: 'error',
    });
    const { routineId } = await copied(task, 'd1');
    expect(await rowOf(routineId)).toMatchObject({
      task_status: null, task_update: null, task_ask: null, task_reported_at: null, task_report_accepted_at: null,
      agent_notes: null, agent_notes_cleared_at: null, task_reading_value: null, task_reading_label: null, task_reading_reported_at: null,
      task_misses_in_a_row: 0, task_miss_reason: null, task_miss_at: null, task_auto_paused_at: null,
      last_run_at: null, last_status: null, last_error: null, last_warning: null, finish_by: null, task_steps: [],
    });
    expect(await f.store.findOne({ agentId: 'a', routineId })).toMatchObject({ task: null, noRecentUpdate: null, finishBy: null });
    expect((await f.store.findOne(task))?.finishBy).toBe('2026-11-14');
    for (const table of ['routines_v1_replies', 'routines_v1_fires', 'routines_v1_dispatches'] as const) {
      expect(await rowsFor(table, task.routineId), table).toBe(1);
      expect(await rowsFor(table, routineId), table).toBe(0);
    }
    expect(JSON.stringify(await rowOf(routineId))).not.toContain('QX7731');
  });

  it('the same request again answers the same copy and makes one row; another request makes another copy', async () => {
    const task = await createTask('task');
    const other = await createTask('other');
    const copies = async () => (await f.store.list({ agentId: 'a' })).filter(row => row.name === 'Copy of Move the help docs').map(row => row.routineId).sort();
    const first = await copied(task, 'd1');
    expect(first).toEqual({ routineId: expect.stringMatching(/^rtn_/), replayed: false });
    expect(await duplicate(task, 'd1')).toEqual({ routineId: first.routineId, replayed: true });
    expect(await copies()).toEqual([first.routineId]);
    const second = await copied(task, 'd2');
    expect(second).toEqual({ routineId: expect.stringMatching(/^rtn_/), replayed: false });
    expect(second.routineId).not.toBe(first.routineId);
    expect(await copies()).toEqual([first.routineId, second.routineId].sort());
    // A receipt's key names no routine, so only its hash keeps one task's request from answering for another's.
    await expect(duplicate(other, 'd1')).rejects.toMatchObject({ toolCode: 'request-conflict' });
    expect(await copies()).toHaveLength(2);
  });

  it('keeps only the copy’s id in its receipt', async () => {
    const task = await createTask('task');
    await writeSteps(task.routineId, [step('s000001', 'Export every article', false, 'agent')]);
    const { routineId } = await copied(task, 'd1');
    expect(await receipts()).toEqual([{ operation: 'duplicate', request_id: 'd1', result: { routineId } }]);
  });

  it('a repeat routine, a default, a missing task and someone else’s are refused, and nothing is written', async () => {
    const task = await createTask('task');
    const repeat = await f.store.createAuthored(createInput('repeat'));
    const { defaultRoutineId } = await f.store.upsertDefault({ ...createInput().definition, name: 'copy-check', trigger: { kind: 'interval', every: '60s' } });
    await f.store.materializeMissing({ agents: [{ agentId: 'a', ownerUserId: 'owner' }], now });
    const materialized = (await f.store.list({ agentId: 'a' })).find(row => row.definitionId === defaultRoutineId)!;
    expect(materialized.ownerUserId).toBe('owner');
    const rows = await definitionRows();
    for (const routineId of [repeat.routineId, materialized.routineId, 'rtn_missing']) {
      expect(await duplicate({ agentId: 'a', routineId }, `d-${routineId}`), routineId).toBe('not-found');
    }
    // A default stays put even when a hand edit made it a task: the default's own column decides, not its kind.
    await sql`UPDATE routines_v1_definitions SET kind = 'stay-on-top', good_when = 'Fine.' WHERE routine_id = ${materialized.routineId}`.execute(f.db);
    expect(await duplicate(materialized, 'd-edited-default')).toBe('not-found');
    // The person who made the task doesn't own it.
    expect(await duplicate(task, 'd9', 'editor')).toBe('forbidden');
    expect(await duplicate(task, 'd10', 'teammate')).toBe('forbidden');
    expect(await definitionRows()).toBe(rows);
    expect(await receipts()).toEqual([]);
  });

  it('a task holding a webhook trigger, which no task can have, is not-found rather than a validation error', async () => {
    const task = await createTask('task');
    await sql`UPDATE routines_v1_definitions SET trigger_kind = 'webhook', trigger_spec = ${JSON.stringify({ kind: 'webhook', path: '/hook' })}::jsonb
      WHERE routine_id = ${task.routineId}`.execute(f.db);
    const rows = await definitionRows();
    expect(await duplicate(task, 'd1')).toBe('not-found');
    expect(await definitionRows()).toBe(rows);
    expect(await receipts()).toEqual([]);
  });

  it('a task today’s rules refuse is a validation error, and nothing is written', async () => {
    const task = await createTask('task');
    await sql`UPDATE routines_v1_definitions SET good_when = '' WHERE routine_id = ${task.routineId}`.execute(f.db);
    const rows = await definitionRows();
    await expect(duplicate(task, 'd1')).rejects.toMatchObject({ toolCode: 'validation' });
    expect(await definitionRows()).toBe(rows);
    expect(await receipts()).toEqual([]);
  });

  it('a task whose copy is too large to save is a validation error on promptBody, and nothing is written', async () => {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const empty = RoutineDefinitionSchema.parse({ ...GET_DONE, name: 'T', promptBody: '' });
    const room = ROUTINE_DEFINITION_MAX_BYTES - 4 - bytes(empty);
    const definition = RoutineDefinitionSchema.parse({ ...empty, promptBody: 'Move the docs. '.repeat(Math.ceil(room / 15)).slice(0, room) });
    expect(bytes(definition)).toBe(ROUTINE_DEFINITION_MAX_BYTES - 4);
    // The copy adds 9 bytes ("Copy of ", and false for true), so it lands 5 over the cap.
    expect(bytes({ ...definition, name: 'Copy of T', enabled: false })).toBe(ROUTINE_DEFINITION_MAX_BYTES + 5);
    const task = await createTask('task', definition);
    const rows = await definitionRows();
    await expect(duplicate(task, 'd1')).rejects.toMatchObject({ toolCode: 'validation', field: 'promptBody' });
    expect(await definitionRows()).toBe(rows);
    expect(await receipts()).toEqual([]);
  });

  it('a retired agent’s task is not-found', async () => {
    const task = await createTask('task');
    await f.store.purgeAgent('a');
    await expect(duplicate(task, 'd1')).rejects.toMatchObject({ toolCode: 'not-found' });
    expect(await receipts()).toEqual([]);
  });
});
