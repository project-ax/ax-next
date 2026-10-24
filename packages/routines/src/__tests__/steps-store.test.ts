import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { StoredRoutineSchema } from '../definition.js';
import type { StoredStep } from '../types.js';

// TASK-948: a "get-done" task's checklist, as the store keeps it: one JSONB list on the routine's row, read
// leniently, cleared with the rest of a task's state, and edited only by its check-ins' reports.
const f = fixture();
const GET_DONE = RoutineDefinitionSchema.parse({
  name: 'Move the help docs', promptBody: 'Move our help docs to the new site.', trigger: { kind: 'interval', every: '1h' },
  kind: 'get-done', goodWhen: 'Every article is on the new site.',
});
const taskInput = (requestId: string) => ({ ...createInput(requestId), definition: GET_DONE });
const step = (id: string, text: string, over: Partial<StoredStep> = {}): StoredStep => ({ id, text, done: false, addedBy: 'agent', ...over });
/** `task_steps` written by hand, as a rollback, a hand edit or a later version would leave it. */
const setSteps = (routineId: string, value: unknown) =>
  sql`UPDATE routines_v1_definitions SET task_steps = ${JSON.stringify(value)}::jsonb WHERE routine_id = ${routineId}`.execute(f.db);
const stepsColumn = async (routineId: string) =>
  (await sql<{ task_steps: unknown }>`SELECT task_steps FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0]?.task_steps;
const due = (row: { nextRunAt: Date | null }) =>
  f.store.claimDue({ now: new Date(row.nextRunAt!.getTime() + 3_600_000), limit: 10, claimWindowMinutes: 5 });

describe("a get-done task's stored checklist (TASK-948)", () => {
  it('a new task has an empty checklist, and its stored steps read back in order', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    expect(task).toMatchObject({ kind: 'get-done', steps: [] });
    expect(await stepsColumn(task.routineId)).toEqual([]);
    const list = [step('s000001', 'Export every article', { done: true }), step('s000002', 'Ask Dana to review billing', { addedBy: 'person' })];
    await setSteps(task.routineId, list);
    expect((await f.store.findOne(task))?.steps).toEqual(list);
    expect((await f.store.list({ agentId: 'a' })).map(row => row.steps)).toEqual([list]);
  });

  it("a checklist that isn't a list, or entries that aren't whole steps, read as the whole steps alone, and the tick still runs", async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    for (const value of [{ not: 'a list' }, 'steps', null]) {
      await setSteps(task.routineId, value);
      expect((await f.store.findOne(task))?.steps, JSON.stringify(value)).toEqual([]);
    }
    await setSteps(task.routineId, [1, { id: 's000002', text: 'Not a flag', done: 'yes', addedBy: 'agent' }, step('s000001', 'Keep me'), step('s000001', 'Same id')]);
    expect((await f.store.findOne(task))?.steps).toEqual([step('s000001', 'Keep me')]);
    // claimDue parses every due row, so one odd row can't stop the tick for everyone (TASK-913).
    expect(await due(task)).toEqual([expect.objectContaining({ routineId: task.routineId, steps: [step('s000001', 'Keep me')] })]);
  });

  it('a change of kind or of owner starts the checklist over; any other edit keeps it', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const list = [step('s000001', 'Export every article', { done: true })];
    await setSteps(task.routineId, list);
    const edit = (requestId: string, expectedRevision: string, patch: Record<string, unknown>) => f.store.updateAuthored({
      agentId: 'a', routineId: task.routineId, expectedRevision, actorUserId: 'owner', requestId, patch, now, stopOnly: false,
    });
    const described = await edit('describe', task.revision, { description: 'Moving the docs.' });
    expect(described.steps).toEqual(list);
    const stay = await edit('to-stay-on-top', described.revision, { kind: 'stay-on-top' });
    expect(stay).toMatchObject({ kind: 'stay-on-top', steps: [] });
    expect(await stepsColumn(task.routineId)).toEqual([]);
    // A change of owner (drift repair) clears it too, in the statement that moves the task (TASK-936).
    const other = await f.store.createAuthored(taskInput('other'));
    await setSteps(other.routineId, list);
    expect(await f.store.reconcileOwners({ agents: [{ agentId: 'a', ownerUserId: 'new-owner' }] })).toBe(2);
    expect(await stepsColumn(other.routineId)).toEqual([]);
  });

  it('receipts keep no steps, and the live accept hands over the steps it read under the row lock', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const list = [step('s000001', 'STEP-TEXT Export every article')];
    await setSteps(task.routineId, list);
    const edit = { agentId: 'a', routineId: task.routineId, expectedRevision: task.revision, actorUserId: 'owner', requestId: 'edit', patch: { description: 'Moving.' }, now, stopOnly: false };
    const edited = await f.store.updateAuthored(edit);
    expect(edited.steps).toEqual(list);
    const dispatch = { agentId: 'a', routineId: task.routineId, expectedRevision: edited.revision, actorUserId: 'owner', source: 'manual', requestId: 'run', now } as const;
    expect((await f.store.acceptDispatch(dispatch))?.accepted.row.steps).toEqual(list);
    const receipts = (await sql<{ operation: string; result: unknown }>`SELECT operation, result FROM routines_v1_requests WHERE agent_id = 'a' ORDER BY operation, request_id`.execute(f.db)).rows;
    expect(receipts.map(receipt => receipt.operation)).toEqual(['create', 'dispatch', 'update']);
    expect(JSON.stringify(receipts)).not.toContain('STEP-TEXT');
    // The key is left out rather than stored as [], so code from before this field still reads every receipt.
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM routines_v1_requests WHERE result ? 'steps' OR result->'row' ? 'steps'`.execute(f.db)).rows[0]?.n).toBe(0);
    const beforeThisField = StoredRoutineSchema.innerType().omit({ steps: true });
    for (const { operation, result } of receipts) {
      expect(beforeThisField.safeParse(operation === 'dispatch' ? (result as { row: unknown }).row : result).success, operation).toBe(true);
    }
    // An exact replay answers from its receipt: no steps.
    expect((await f.store.updateAuthored(edit)).steps).toEqual([]);
    expect((await f.store.acceptDispatch(dispatch))?.accepted.row.steps).toEqual([]);
  });
});
