import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { CHECK_IN_MISSES, RoutineDefinitionSchema } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { parseStoredRoutine, StoredRoutineSchema } from '../definition.js';
import { AcceptedDispatchSchema } from '../dispatch.js';

// TASK-930: a task's check-ins in a row that ended without a report, as the
// store reads them back. Only finishDispatch and updateAuthored write the
// columns; these tests set them by hand, as a rollback or a hand edit could, to
// pin what every read makes of them.
const f = fixture();
const taskInput = (requestId: string) => ({ ...createInput(requestId), definition: RoutineDefinitionSchema.parse({
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
}) });
/** Due an hour after the row's next run, so `claimDue` takes it. */
const claimed = async (row: { nextRunAt: Date | null }) =>
  f.store.claimDue({ now: new Date(row.nextRunAt!.getTime() + 3_600_000), limit: 10, claimWindowMinutes: 5 });
const missedAt = new Date(now.getTime() - 15 * 60_000);
type MissColumns = { task_misses_in_a_row?: number; task_miss_reason?: string | null; task_miss_at?: Date | null; task_auto_paused_at?: Date | null };
/** Writes a task's miss columns by hand: anything left out reads as no misses. */
const setMisses = (routineId: string, columns: MissColumns) => sql`
  UPDATE routines_v1_definitions
     SET task_misses_in_a_row = ${columns.task_misses_in_a_row ?? 0}, task_miss_reason = ${columns.task_miss_reason ?? null},
         task_miss_at = ${columns.task_miss_at ?? null}, task_auto_paused_at = ${columns.task_auto_paused_at ?? null}
   WHERE routine_id = ${routineId}`.execute(f.db);

describe("a task's missed check-ins, read back (TASK-930)", () => {
  it('a row whose miss columns are partly set or hold no count reads as no misses, and the tick still runs', async () => {
    const row = await f.store.createAuthored(taskInput('partial'));
    expect(row.noRecentUpdate).toBeNull();
    const partly: MissColumns[] = [
      { task_misses_in_a_row: 0, task_miss_reason: 'no-report', task_miss_at: missedAt },
      { task_misses_in_a_row: -3, task_miss_reason: 'no-report', task_miss_at: missedAt },
      { task_misses_in_a_row: 2, task_miss_reason: 'failed', task_miss_at: null },
      // A pause stamp alone isn't a miss either.
      { task_auto_paused_at: missedAt },
    ];
    for (const set of partly) {
      await setMisses(row.routineId, set);
      expect((await f.store.findOne(row))?.noRecentUpdate, JSON.stringify(set)).toBeNull();
      expect((await f.store.list({ agentId: 'a' })).map(r => r.noRecentUpdate), JSON.stringify(set)).toEqual([null]);
      // The tick parses every due row, so one such row can't stop it for everyone.
      expect(await claimed(row), JSON.stringify(set)).toEqual([expect.objectContaining({ routineId: row.routineId, noRecentUpdate: null })]);
    }
  });

  it('a full row reads back exactly, wherever a routine is read', async () => {
    const row = await f.store.createAuthored(taskInput('full'));
    await setMisses(row.routineId, { task_misses_in_a_row: 4, task_miss_reason: 'brief-too-long', task_miss_at: missedAt });
    const misses = { inARow: 4, reason: 'brief-too-long', at: missedAt, autoPausedAt: null };
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual(misses);
    expect((await f.store.list({ agentId: 'a' })).map(r => r.noRecentUpdate)).toEqual([misses]);
    expect(await claimed(row)).toEqual([expect.objectContaining({ routineId: row.routineId, noRecentUpdate: misses })]);
    // Every reason reads back as itself.
    for (const reason of CHECK_IN_MISSES) {
      await setMisses(row.routineId, { task_misses_in_a_row: 1, task_miss_reason: reason, task_miss_at: missedAt });
      expect((await f.store.findOne(row))?.noRecentUpdate, reason).toEqual({ inARow: 1, reason, at: missedAt, autoPausedAt: null });
    }
    // Paused for them: the stamp comes along.
    const pausedAt = new Date(now.getTime() - 60_000);
    await setMisses(row.routineId, { task_misses_in_a_row: 5, task_miss_reason: 'no-report', task_miss_at: missedAt, task_auto_paused_at: pausedAt });
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual({ inARow: 5, reason: 'no-report', at: missedAt, autoPausedAt: pausedAt });
    // A count and a time make a miss. A reason missing beside them reads failed, as one no code knows does.
    await setMisses(row.routineId, { task_misses_in_a_row: 2, task_miss_reason: null, task_miss_at: missedAt });
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual({ inARow: 2, reason: 'failed', at: missedAt, autoPausedAt: null });
  });

  it('receipts keep no copy of the misses; the live answers keep them', async () => {
    const created = await f.store.createAuthored(taskInput('create'));
    await setMisses(created.routineId, { task_misses_in_a_row: 2, task_miss_reason: 'no-report', task_miss_at: missedAt });
    const misses = { inARow: 2, reason: 'no-report', at: missedAt, autoPausedAt: null };
    const edit = {
      agentId: 'a', routineId: created.routineId, expectedRevision: created.revision, actorUserId: 'owner',
      requestId: 'edit', patch: { description: 'Edited.' }, now, stopOnly: false,
    };
    const edited = await f.store.updateAuthored(edit);
    expect(edited.noRecentUpdate).toEqual(misses);
    // The live accept hands over the misses as it read them under the row lock: the
    // next check-in's message takes them from there.
    const dispatch = { agentId: 'a', routineId: created.routineId, expectedRevision: edited.revision, actorUserId: 'owner', source: 'manual', requestId: 'next', now } as const;
    const next = await f.store.acceptDispatch(dispatch);
    expect(next?.replayed).toBe(false);
    expect(next?.accepted.row.noRecentUpdate).toEqual(misses);
    const receipts = (await sql<{ operation: string; result: unknown }>`SELECT operation, result FROM routines_v1_requests WHERE agent_id = 'a' ORDER BY operation, request_id`.execute(f.db)).rows;
    expect(receipts.map(receipt => receipt.operation)).toEqual(['create', 'dispatch', 'update']);
    // They leave the key out rather than store null, so code from before this field, whose strict
    // schema has no such key, still reads them after a rollback.
    const keyed = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM routines_v1_requests WHERE result ? 'noRecentUpdate' OR result->'row' ? 'noRecentUpdate'`.execute(f.db)).rows[0];
    expect(keyed?.n).toBe(0);
    const beforeThisField = StoredRoutineSchema.innerType().omit({ noRecentUpdate: true });
    for (const { operation, result } of receipts) {
      const routine = operation === 'dispatch' ? (result as { row: unknown }).row : result;
      expect(beforeThisField.safeParse(routine).success, operation).toBe(true);
    }
    // So exact replays answer with no misses: the receipt's answer, as replays always are, never a fresh read.
    expect(await f.store.updateAuthored(edit)).toEqual({ ...edited, noRecentUpdate: null });
    const replay = await f.store.acceptDispatch(dispatch);
    expect(replay?.replayed).toBe(true);
    expect(replay?.accepted.row.noRecentUpdate).toBeNull();
    // And one written before this field, with no such key, parses with none.
    const { noRecentUpdate: _misses, ...before } = JSON.parse(JSON.stringify(edited)) as Record<string, unknown>;
    expect(parseStoredRoutine(before).noRecentUpdate).toBeNull();
    expect(AcceptedDispatchSchema.parse({ dispatchId: 'd', reqId: 'q', row: before, source: 'manual', acceptedAt: now.toISOString() }).row.noRecentUpdate).toBeNull();
  });
});
