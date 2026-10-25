import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { StoredRoutineSchema } from '../definition.js';

// TASK-951: a "get-done" task's finish date, as the store keeps it: a TEXT column of its own on the routine's row
// (schema version 12), read through the contract's rule, written only by setFinishBy (the owner's, under the agent
// fence and the row lock, never moving the revision), cleared by a change of kind, kept by a change of owner, and
// left out of every receipt. The columns a date must not move aren't on StoredRoutine, so they're read with SQL.
const f = fixture();
const GET_DONE = RoutineDefinitionSchema.parse({
  name: 'Move the help docs', promptBody: 'Move our help docs to the new site.', trigger: { kind: 'interval', every: '1h' },
  kind: 'get-done', goodWhen: 'Every article is on the new site.',
});
const STAY_ON_TOP = RoutineDefinitionSchema.parse({
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
});
const taskInput = (requestId: string) => ({ ...createInput(requestId), definition: GET_DONE });
const setFinishBy = (routineId: string, finishBy: string | null, actorUserId = 'owner') =>
  f.store.setFinishBy({ agentId: 'a', routineId, actorUserId, finishBy });
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
/** Every column of the routine's row, so "nothing else on the row moves" means nothing: revision, spec_hash and updated_at included. */
const wholeRow = async (routineId: string) => (await sql<Record<string, unknown>>`
  SELECT * FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0];
const finishByColumn = async (routineId: string) => (await wholeRow(routineId))?.finish_by;
const receipts = async () => (await sql<{ operation: string; request_id: string; result: unknown }>`
  SELECT operation, request_id, result FROM routines_v1_requests WHERE agent_id = 'a' ORDER BY operation, request_id`.execute(f.db)).rows;

describe("a get-done task's stored finish date (TASK-951)", () => {
  it("the owner sets a get-done task's finish date and removes it, and nothing else on the row moves", async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    expect(task.finishBy).toBeNull();
    const before = await wholeRow(task.routineId);
    expect(before).toMatchObject({ finish_by: null });
    expect(await setFinishBy(task.routineId, '2026-11-14')).toEqual({ finishBy: '2026-11-14' });
    expect((await f.store.findOne(task))?.finishBy).toBe('2026-11-14');
    expect((await f.store.list({ agentId: 'a' })).map(row => row.finishBy)).toEqual(['2026-11-14']);
    expect(await wholeRow(task.routineId)).toEqual({ ...before, finish_by: '2026-11-14' });
    expect(await setFinishBy(task.routineId, null)).toEqual({ finishBy: null });
    expect((await f.store.findOne(task))?.finishBy).toBeNull();
    // The revision, spec_hash and updated_at are the ones from before the first call, and no receipt was kept.
    expect(await wholeRow(task.routineId)).toEqual(before);
    expect((await receipts()).map(receipt => receipt.operation)).toEqual(['create']);
  });

  it('anyone but the owner is forbidden, and the date stays', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    expect(await setFinishBy(task.routineId, '2026-11-14')).toEqual({ finishBy: '2026-11-14' });
    const before = await wholeRow(task.routineId);
    // 'editor' made the task; 'owner' owns it.
    expect(await setFinishBy(task.routineId, '2027-01-01', 'editor')).toBe('forbidden');
    expect(await setFinishBy(task.routineId, null, 'editor')).toBe('forbidden');
    expect(await wholeRow(task.routineId)).toEqual(before);
  });

  it("a stay-on-top task, a repeat routine, a routine that isn't there and a retired agent are not-found", async () => {
    const stay = await f.store.createAuthored({ ...createInput('stay'), definition: STAY_ON_TOP });
    const repeat = await f.store.createAuthored(createInput('repeat'));
    const task = await f.store.createAuthored(taskInput('task'));
    for (const routineId of [stay.routineId, repeat.routineId, 'rtn_missing']) {
      expect(await setFinishBy(routineId, '2026-11-14'), routineId).toBe('not-found');
    }
    await sql`INSERT INTO routines_v1_retired_agents (agent_id) VALUES ('a')`.execute(f.db);
    expect(await setFinishBy(task.routineId, '2026-11-14')).toBe('not-found');
    // None of them wrote anything.
    expect((await sql`SELECT routine_id FROM routines_v1_definitions WHERE finish_by IS NOT NULL`.execute(f.db)).rows).toEqual([]);
  });

  it('a change of kind clears it in the edit itself; a change of owner keeps it', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await setFinishBy(task.routineId, '2026-11-14');
    const edit = (requestId: string, expectedRevision: string, patch: Record<string, unknown>) => f.store.updateAuthored({
      agentId: 'a', routineId: task.routineId, expectedRevision, actorUserId: 'owner', requestId, patch, now, stopOnly: false,
    });
    const described = await edit('describe', task.revision, { description: 'Moving the docs.' });
    expect(described.finishBy).toBe('2026-11-14');
    const stay = await edit('to-stay-on-top', described.revision, { kind: 'stay-on-top' });
    expect(stay).toMatchObject({ kind: 'stay-on-top', finishBy: null });
    expect((await f.store.findOne(task))?.finishBy).toBeNull();
    expect(await finishByColumn(task.routineId)).toBeNull();
    // Back to get-done, the task starts over: the old date doesn't come back.
    const back = await edit('to-get-done', stay.revision, { kind: 'get-done' });
    expect(back).toMatchObject({ kind: 'get-done', finishBy: null });
    expect((await f.store.findOne(task))?.finishBy).toBeNull();

    // A change of owner (drift repair) starts the task's state over in the statement that moves it (TASK-936), and
    // leaves the date: it is about the work, not text from the earlier owner's runs.
    const other = await f.store.createAuthored(taskInput('other'));
    await setFinishBy(other.routineId, '2026-11-14');
    await sql`UPDATE routines_v1_definitions SET task_status = 'on-track', task_update = 'Moving.', task_reported_at = ${now} WHERE routine_id = ${other.routineId}`.execute(f.db);
    expect((await f.store.findOne(other))?.task).toMatchObject({ status: 'on-track' });
    expect(await f.store.reconcileOwners({ agents: [{ agentId: 'a', ownerUserId: 'new-owner' }] })).toBe(2);
    expect(await f.store.findOne(other)).toMatchObject({ ownerUserId: 'new-owner', task: null, finishBy: '2026-11-14' });
    // Who may set it moves with the task.
    expect(await setFinishBy(other.routineId, null, 'owner')).toBe('forbidden');
    expect(await setFinishBy(other.routineId, '2026-12-01', 'new-owner')).toEqual({ finishBy: '2026-12-01' });
  });

  it('a kind change that commits while setFinishBy waits on the row lock makes it not-found', async () => {
    // The kind and the owner are read under the row lock: in READ COMMITTED, a call that waits there reads the row
    // the other transaction committed. Read before the lock, it would put a date on a stay-on-top task.
    const task = await f.store.createAuthored(taskInput('task'));
    const { waiting } = await f.db.transaction().execute(async trx => {
      // A person-approved edit's hold on the task's row, by the backend that holds it.
      const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid FROM routines_v1_definitions WHERE agent_id = ${task.agentId} AND routine_id = ${task.routineId} FOR UPDATE`.execute(trx);
      const waiting = setFinishBy(task.routineId, '2026-11-14');
      await waitsOn(rows[0]!.pid);
      // Only now, with the date waiting, does the edit change the kind. It lands when the hold ends.
      await sql`UPDATE routines_v1_definitions SET kind = 'stay-on-top' WHERE agent_id = ${task.agentId} AND routine_id = ${task.routineId}`.execute(trx);
      return { waiting };
    });
    expect(await waiting).toBe('not-found');
    expect(await finishByColumn(task.routineId)).toBeNull();
  });

  it('a stored date no calendar has reads as none, and the tick still claims the row', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    // The CHECK holds the format only, so a hand edit or a later version can leave any of these. Read as is, the
    // first would make Intl throw wherever it is shown or counted, and the last would roll over into March. The
    // second is a real day outside the rule's years.
    for (const value of ['2026-13-45', '2101-01-01', '2026-02-30']) {
      await sql`UPDATE routines_v1_definitions SET finish_by = ${value} WHERE routine_id = ${task.routineId}`.execute(f.db);
      expect((await f.store.findOne(task))?.finishBy, value).toBeNull();
      expect((await f.store.list({ agentId: 'a' })).map(row => row.finishBy), value).toEqual([null]);
    }
    // claimDue parses every due row, so one odd row can't stop the tick for everyone (TASK-913).
    const claimed = await f.store.claimDue({ now: new Date(task.nextRunAt!.getTime() + 3_600_000), limit: 10, claimWindowMinutes: 5 });
    expect(claimed).toEqual([expect.objectContaining({ routineId: task.routineId, finishBy: null })]);
  });

  it('a receipt leaves the date out, so code from before version 12 still reads it, and an exact replay answers none', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await setFinishBy(task.routineId, '2026-11-14');
    const edit = { agentId: 'a', routineId: task.routineId, expectedRevision: task.revision, actorUserId: 'owner', requestId: 'edit', patch: { description: 'x' }, now, stopOnly: false };
    const edited = await f.store.updateAuthored(edit);
    expect(edited.finishBy).toBe('2026-11-14');
    const dispatch = { agentId: 'a', routineId: task.routineId, expectedRevision: edited.revision, actorUserId: 'owner', source: 'manual', requestId: 'run', now } as const;
    // The live accept hands over the date it read under the row lock: the check-in's brief reads this row.
    expect((await f.store.acceptDispatch(dispatch))?.accepted.row.finishBy).toBe('2026-11-14');
    const kept = await receipts();
    expect(kept.map(receipt => receipt.operation)).toEqual(['create', 'dispatch', 'update']);
    // The key is left out rather than stored as null, so code from before this field (whose strict schema has no
    // such key) still reads every receipt after a rollback.
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM routines_v1_requests WHERE result ? 'finishBy' OR result->'row' ? 'finishBy'`.execute(f.db)).rows[0]?.n).toBe(0);
    const beforeThisField = StoredRoutineSchema.innerType().omit({ finishBy: true });
    for (const { operation, result } of kept) {
      expect(beforeThisField.safeParse(operation === 'dispatch' ? (result as { row: unknown }).row : result).success, operation).toBe(true);
    }
    // An exact replay answers from its receipt: no date.
    expect((await f.store.updateAuthored(edit)).finishBy).toBeNull();
    expect((await f.store.acceptDispatch(dispatch))?.accepted.row.finishBy).toBeNull();
  });
});
