import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { CHECK_IN_MISSES, RoutineDefinitionSchema, TASK_AUTO_PAUSE_AFTER_MISSES, type RoutinePatch } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { captureExpectedStderr } from './support/expected-diagnostics.js';
import { parseStoredRoutine, StoredRoutineSchema } from '../definition.js';
import { AcceptedDispatchSchema } from '../dispatch.js';
import type { DispatchOutcome, DispatchReport } from '../types.js';

// TASK-930: a task's check-ins in a row that ended without a report. The first
// describe pins what every read makes of the columns, set by hand as a rollback
// or a hand edit could; the second, how finishDispatch and updateAuthored (their
// only writers) count, pause and start over.
const f = fixture();
afterEach(() => { vi.restoreAllMocks(); });
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

const onTrack = { status: 'on-track', update: 'Queue is empty.', ask: null } as const;
type Key = { agentId: string; routineId: string; revision: string };
/** `i` minutes after `now`. Runs are accepted in order, so the latest one's status is the routine's (finishDispatch skips an older run's). */
const minute = (i: number) => new Date(now.getTime() + i * 60_000);
/** Request ids are per agent, so a test with two routines keys each run by its routine too. */
const runId = (row: Key, name: string) => `${row.routineId}/${name}`;
/** A run of `row` accepted at `at` and bound to its own conversation, that reports `report` when there is one. */
async function checkIn(row: Key, name: string, { at = now, report }: { at?: Date; report?: DispatchReport } = {}) {
  const requestId = runId(row, name), conversationId = `c-${requestId}`;
  const { accepted } = (await f.store.acceptDispatch({
    agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', source: 'manual', requestId, now: at,
  }))!;
  await f.store.bindDispatchConversation({ dispatchId: accepted.dispatchId, conversationId });
  if (report !== undefined) {
    expect(await f.store.recordReport({ agentId: row.agentId, dispatchId: accepted.dispatchId, conversationId, actorUserId: 'owner', report, now: at })).toBe('recorded');
  }
  return { ...accepted, conversationId };
}
const OK: DispatchOutcome = { status: 'ok', conversationId: 'c', error: null, renderedPrompt: 'ran', warning: null };
const finish = async (dispatchId: string, outcome: Partial<DispatchOutcome> = {}) => {
  expect(await f.store.finishDispatch({ dispatchId, outcome: { ...OK, ...outcome } })).toBe(true);
};
/** `count` check-ins in a row that end without a report, accepted a minute apart from minute `from`. */
async function missed(row: Key, count: number, from = 1) {
  for (let i = from; i < from + count; i++) await finish((await checkIn(row, `miss-${i}`, { at: minute(i) })).dispatchId);
}
/** A person's edit, as routines:update makes it. */
const edit = (row: Key, name: string, patch: RoutinePatch) => f.store.updateAuthored({
  agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', requestId: runId(row, name), patch, now, stopOnly: false,
});
const NO_MISSES = { task_misses_in_a_row: 0, task_miss_reason: null, task_miss_at: null, task_auto_paused_at: null };
const missColumns = async (routineId: string) => (await sql<Record<string, unknown>>`
  SELECT task_misses_in_a_row, task_miss_reason, task_miss_at, task_auto_paused_at FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0];
const definitionRow = async (routineId: string) => (await sql<Record<string, unknown>>`
  SELECT * FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0];
const pausedLine = (routineId: string) =>
  `[ax/routines] auto-paused task a/${routineId} after ${TASK_AUTO_PAUSE_AFTER_MISSES} check-ins without a report\n`;
/** Beside `pausedLine` when the paused definition's hash couldn't be worked out. Every other test's lines say it wasn't written. */
const keptHashLine = (routineId: string) =>
  `[ax/routines] auto-paused task a/${routineId} kept its stored definition hash: its definition no longer reads\n`;
/** The auto-pause's stderr lines, captured until the test ends. Anything else still prints. */
const pauseLines = () => captureExpectedStderr(message => message.startsWith('[ax/routines] auto-paused task ')).messages;

describe("a task's missed check-ins, counted (TASK-930)", () => {
  it('a check-in that finishes without a report counts, with its start as the time and no-report as the reason', async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    const first = await checkIn(row, 'first', { at: minute(1) });
    await finish(first.dispatchId);
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual({ inARow: 1, reason: 'no-report', at: first.acceptedAt, autoPausedAt: null });
    // Silenced is no report either.
    const second = await checkIn(row, 'second', { at: minute(2) });
    await finish(second.dispatchId, { status: 'silenced' });
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual({ inARow: 2, reason: 'no-report', at: second.acceptedAt, autoPausedAt: null });
    // The time is the run's start, which is also its entry's time in the task's history.
    expect((await f.store.recentFires(row)).map(fire => fire.firedAt)).toEqual([second.acceptedAt, first.acceptedAt]);
  });

  it.each(['brief-missing', 'brief-unconfirmed', 'brief-too-long', 'interrupted', 'failed', undefined] as const)(
    'a run that ended in an error records the reason its caller gave (%s), and failed when it gave none', async (reason) => {
      const row = await f.store.createAuthored(taskInput('task'));
      const run = await checkIn(row, 'run', { at: minute(1) });
      await finish(run.dispatchId, { status: 'error', error: 'boom', ...(reason === undefined ? {} : { miss: reason }) });
      expect((await f.store.findOne(row))?.noRecentUpdate).toEqual({ inARow: 1, reason: reason ?? 'failed', at: run.acceptedAt, autoPausedAt: null });
    });

  it("a run that didn't end in an error left no report, whatever reason its caller gave; no-report is never a caller's to give", async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    for (const [i, status] of (['ok', 'silenced'] as const).entries()) {
      await finish((await checkIn(row, status, { at: minute(i + 1) })).dispatchId, { status, miss: 'brief-too-long' });
      expect((await f.store.findOne(row))?.noRecentUpdate, status).toMatchObject({ inARow: i + 1, reason: 'no-report' });
    }
    // The store decides no-report. A caller that names it, or a reason no code knows, is refused before anything is written.
    const refused = await checkIn(row, 'refused', { at: minute(3) });
    for (const miss of ['no-report', 'gremlins']) {
      const outcome = { ...OK, status: 'error', error: 'boom', miss } as unknown as DispatchOutcome;
      await expect(f.store.finishDispatch({ dispatchId: refused.dispatchId, outcome }), miss).rejects.toThrow();
    }
    expect(await f.store.recentFires(row)).toHaveLength(2);
    expect((await f.store.findOne(row))?.noRecentUpdate?.inARow).toBe(2);
  });

  it('a report clears the count, even on a run that then ended in an error', async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    await missed(row, 2);
    const reported = await checkIn(row, 'reported', { at: minute(3), report: onTrack });
    await finish(reported.dispatchId, { status: 'error', error: 'boom' });
    expect((await f.store.findOne(row))?.noRecentUpdate).toBeNull();
    expect(await missColumns(row.routineId)).toEqual(NO_MISSES);
  });

  it('a repeat routine never counts, and never pauses', async () => {
    const row = await f.store.createAuthored(createInput('repeat'));
    for (let i = 1; i <= TASK_AUTO_PAUSE_AFTER_MISSES + 1; i++) {
      await finish((await checkIn(row, `run-${i}`, { at: minute(i) })).dispatchId, i % 2 === 0 ? { status: 'error', error: 'boom' } : {});
    }
    expect(await f.store.findOne(row)).toMatchObject({ enabled: true, revision: row.revision, noRecentUpdate: null });
    expect(await missColumns(row.routineId)).toEqual(NO_MISSES);
  });

  it('the fifth miss in a row pauses the task: not enabled, a new revision, a fresh spec hash, no next run, and nothing runs after', async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    await missed(row, TASK_AUTO_PAUSE_AFTER_MISSES - 1);
    const before = (await f.store.findOne(row))!;
    const beforeRow = (await definitionRow(row.routineId))!;
    expect(before).toMatchObject({ enabled: true, noRecentUpdate: { inARow: TASK_AUTO_PAUSE_AFTER_MISSES - 1 } });
    const fifth = await checkIn(row, 'fifth', { at: minute(TASK_AUTO_PAUSE_AFTER_MISSES) });
    const lines = pauseLines();
    const from = Date.now();
    await finish(fifth.dispatchId, { status: 'error', error: 'boom' });
    const to = Date.now();
    // One line for whoever runs the host, ids only.
    expect(lines).toEqual([pausedLine(row.routineId)]);
    const after = (await definitionRow(row.routineId))!;
    expect(after).toMatchObject({ enabled: false, next_run_at: null });
    expect(after.revision).not.toBe(before.revision);
    // The hash a person's pause stores: a twin task with the same definition, paused by its person.
    const twin = await f.store.createAuthored(taskInput('twin'));
    await edit(twin, 'pause', { enabled: false });
    expect(after.spec_hash).toBe((await definitionRow(twin.routineId))!.spec_hash);
    expect(after.spec_hash).not.toBe(beforeRow.spec_hash);
    // One instant for the pause and the row's last change, read off the host's clock.
    const pausedAt = after.task_auto_paused_at as Date;
    expect(pausedAt.getTime()).toBeGreaterThanOrEqual(from);
    expect(pausedAt.getTime()).toBeLessThanOrEqual(to);
    expect(after.updated_at).toEqual(pausedAt);
    // The fifth run keeps its own status and error: the pause's new revision would have skipped them had it come first.
    expect(await f.store.findOne(row)).toMatchObject({
      enabled: false, nextRunAt: null, lastRunAt: fifth.acceptedAt, lastStatus: 'error', lastError: 'boom',
      noRecentUpdate: { inARow: TASK_AUTO_PAUSE_AFTER_MISSES, reason: 'failed', at: fifth.acceptedAt, autoPausedAt: pausedAt },
    });
    // Nothing runs after: the tick claims nothing, and a run asked for against the new revision is refused.
    expect(await f.store.claimDue({ now: new Date('2100-01-01T00:00:00Z'), limit: 10, claimWindowMinutes: 5 })).toEqual([]);
    expect(await f.store.acceptDispatch({
      agentId: 'a', routineId: row.routineId, expectedRevision: after.revision as string, actorUserId: 'owner', source: 'manual', requestId: 'after', now: minute(9),
    })).toBeNull();
  });

  it('an edit held against the revision from before an auto-pause fails as a revision conflict', async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    pauseLines();
    await missed(row, TASK_AUTO_PAUSE_AFTER_MISSES);
    await expect(edit(row, 'stale', { description: 'Edited.' })).rejects.toMatchObject({ toolCode: 'revision-conflict', field: 'expectedRevision' });
    await expect(edit(row, 'stale-resume', { enabled: true })).rejects.toMatchObject({ toolCode: 'revision-conflict', field: 'expectedRevision' });
    expect(await f.store.findOne(row)).toMatchObject({ enabled: false, noRecentUpdate: { inARow: TASK_AUTO_PAUSE_AFTER_MISSES } });
  });

  it('once paused by misses, later runs leave the count alone, with a report or without', async () => {
    const lines = pauseLines();
    for (const report of [undefined, onTrack]) {
      const row = await f.store.createAuthored(taskInput(report === undefined ? 'quiet' : 'reported'));
      await missed(row, TASK_AUTO_PAUSE_AFTER_MISSES - 1);
      // A Check now starts alongside the fifth check-in and finishes after it. It's the newer of the two, so
      // without the freeze its report would clear the pause; one it made before the fifth finished would
      // have stopped the fifth counting at all (the test below).
      const fifth = await checkIn(row, 'fifth', { at: minute(5) });
      const sixth = await checkIn(row, 'sixth', { at: minute(6) });
      await finish(fifth.dispatchId);
      const paused = await missColumns(row.routineId);
      expect(paused).toEqual({ task_misses_in_a_row: 5, task_miss_reason: 'no-report', task_miss_at: fifth.acceptedAt, task_auto_paused_at: expect.any(Date) });
      if (report !== undefined) {
        expect(await f.store.recordReport({
          agentId: 'a', dispatchId: sixth.dispatchId, conversationId: sixth.conversationId, actorUserId: 'owner', report, now: minute(7),
        })).toBe('recorded');
      }
      await finish(sixth.dispatchId, { status: 'error', error: 'late' });
      expect(await missColumns(row.routineId), JSON.stringify(report)).toEqual(paused);
      expect((await f.store.findOne(row))?.enabled).toBe(false);
    }
    expect(lines).toHaveLength(2);
  });

  it("a person's Resume starts the count over; an edit that keeps the task paused keeps the count", async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    pauseLines();
    await missed(row, TASK_AUTO_PAUSE_AFTER_MISSES);
    const paused = (await f.store.findOne(row))!;
    expect(paused.noRecentUpdate).toMatchObject({ inARow: TASK_AUTO_PAUSE_AFTER_MISSES, autoPausedAt: expect.any(Date) });
    // Shortening what to do fixes a brief that was too long, but the task stays paused, and stays counted.
    const shorter = await edit(paused, 'shorter', { promptBody: 'Shorter.' });
    expect(shorter).toMatchObject({ enabled: false, noRecentUpdate: paused.noRecentUpdate });
    const resumed = await edit(shorter, 'resume', { enabled: true });
    expect(resumed).toMatchObject({ enabled: true, nextRunAt: new Date(now.getTime() + 15 * 60_000), noRecentUpdate: null });
    expect(await missColumns(row.routineId)).toEqual(NO_MISSES);
    // A person's own pause and Resume start a task's count over too.
    const other = await f.store.createAuthored(taskInput('other'));
    await missed(other, 2);
    const stopped = await edit(other, 'pause', { enabled: false });
    expect(stopped.noRecentUpdate).toMatchObject({ inARow: 2, autoPausedAt: null });
    expect((await edit(stopped, 'resume', { enabled: true })).noRecentUpdate).toBeNull();
    expect(await missColumns(other.routineId)).toEqual(NO_MISSES);
  });

  it("a run that finishes after a person paused the task counts, but ax doesn't pause it again: same revision, not marked as ax's pause", async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    const lines = pauseLines();
    await missed(row, TASK_AUTO_PAUSE_AFTER_MISSES - 1);
    const open = await checkIn(row, 'open', { at: minute(5) });
    const stopped = await edit(row, 'pause', { enabled: false });
    await finish(open.dispatchId);
    expect(await f.store.findOne(row)).toMatchObject({
      enabled: false, revision: stopped.revision, noRecentUpdate: { inARow: TASK_AUTO_PAUSE_AFTER_MISSES, reason: 'no-report', autoPausedAt: null },
    });
    expect(lines).toEqual([]);
  });

  it('a row a rollback left behind counts on: resumed without starting over, it counts and pauses again; below zero, it counts from one', async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    const lines = pauseLines();
    // Paused for its misses, then resumed by code from before version 7, which didn't start the count over.
    await setMisses(row.routineId, { task_misses_in_a_row: 5, task_miss_reason: 'no-report', task_miss_at: missedAt, task_auto_paused_at: missedAt });
    const run = await checkIn(row, 'run', { at: minute(1) });
    const from = Date.now();
    await finish(run.dispatchId);
    const paused = (await f.store.findOne(row))!;
    expect(paused).toMatchObject({ enabled: false, noRecentUpdate: { inARow: 6, reason: 'no-report', at: run.acceptedAt } });
    expect(paused.noRecentUpdate?.autoPausedAt?.getTime()).toBeGreaterThanOrEqual(from);
    expect(lines).toEqual([pausedLine(row.routineId)]);
    // A hand edit left a count below zero: the next miss is the first.
    const other = await f.store.createAuthored(taskInput('other'));
    await setMisses(other.routineId, { task_misses_in_a_row: -3, task_miss_reason: 'no-report', task_miss_at: missedAt });
    await missed(other, 1);
    expect((await f.store.findOne(other))?.noRecentUpdate?.inARow).toBe(1);
  });

  it('a run still open across a Resume counts from zero', async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    pauseLines();
    await missed(row, TASK_AUTO_PAUSE_AFTER_MISSES - 1);
    const fifth = await checkIn(row, 'fifth', { at: minute(5) });
    const open = await checkIn(row, 'open', { at: minute(6) });
    await finish(fifth.dispatchId);
    await edit((await f.store.findOne(row))!, 'resume', { enabled: true });
    await finish(open.dispatchId);
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual({ inARow: 1, reason: 'no-report', at: open.acceptedAt, autoPausedAt: null });
  });

  it('a kind change clears the misses with the rest of the task state, a pause for them included', async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    pauseLines();
    await missed(row, TASK_AUTO_PAUSE_AFTER_MISSES);
    const repeat = await edit((await f.store.findOne(row))!, 'to-repeat', { kind: 'repeat', goodWhen: null });
    // Still paused: a kind change isn't a Resume.
    expect(repeat).toMatchObject({ kind: 'repeat', enabled: false, noRecentUpdate: null });
    expect(await missColumns(row.routineId)).toEqual(NO_MISSES);
  });

  it("an edit during a check-in doesn't drop its miss", async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    const run = await checkIn(row, 'run', { at: minute(1) });
    const edited = await edit(row, 'edit', { description: 'Edited.' });
    await finish(run.dispatchId);
    // Its status belongs to the revision it ran, so the edit drops that (TASK-907); its miss is the task's.
    expect(await f.store.findOne(row)).toMatchObject({
      revision: edited.revision, lastStatus: null, noRecentUpdate: { inARow: 1, reason: 'no-report', at: run.acceptedAt, autoPausedAt: null },
    });
  });

  it('a run a restart interrupted counts as interrupted, and can be the fifth miss', async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    await missed(row, TASK_AUTO_PAUSE_AFTER_MISSES - 1);
    const fifth = await checkIn(row, 'fifth', { at: minute(5) });
    const lines = pauseLines();
    // Plugin init runs this with no catch around it: it finishes the run, pauses the task, and resolves.
    await expect(f.store.interruptAbandonedDispatches()).resolves.toBe(1);
    expect(lines).toEqual([pausedLine(row.routineId)]);
    expect(await f.store.findOne(row)).toMatchObject({
      enabled: false, nextRunAt: null, lastStatus: 'error', lastError: 'The routine run was interrupted by a host restart.',
      noRecentUpdate: { inARow: TASK_AUTO_PAUSE_AFTER_MISSES, reason: 'interrupted', at: fifth.acceptedAt, autoPausedAt: expect.any(Date) },
    });
  });

  it("a stored definition today's checks refuse still pauses at boot, keeping its stored hash, and says so in ids only", async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    await missed(row, TASK_AUTO_PAUSE_AFTER_MISSES - 1);
    await checkIn(row, 'fifth', { at: minute(5) });
    // Instructions stored before a stricter check: a zero-width space no task's instructions may hold now (TASK-906).
    await sql`UPDATE routines_v1_definitions SET prompt_body = ${'Keep the support queue empty.​'} WHERE routine_id = ${row.routineId}`.execute(f.db);
    await expect(f.store.findOne(row)).rejects.toThrow();
    const before = (await definitionRow(row.routineId))!;
    const lines = pauseLines();
    await expect(f.store.interruptAbandonedDispatches()).resolves.toBe(1);
    // Nothing of why it no longer reads: that's in its stored text.
    expect(lines).toEqual([pausedLine(row.routineId), keptHashLine(row.routineId)]);
    const after = (await definitionRow(row.routineId))!;
    expect(after).toMatchObject({
      enabled: false, spec_hash: before.spec_hash, next_run_at: null,
      task_misses_in_a_row: TASK_AUTO_PAUSE_AFTER_MISSES, task_miss_reason: 'interrupted', task_auto_paused_at: expect.any(Date),
    });
    expect(after.revision).not.toBe(before.revision);
  });

  it('check-ins finishing at once all count, and pause the task once', async () => {
    const lines = pauseLines();
    for (let round = 0; round < 3; round++) {
      const row = await f.store.createAuthored(taskInput(`task-${round}`));
      const runs = [];
      for (let i = 1; i <= TASK_AUTO_PAUSE_AFTER_MISSES; i++) runs.push(await checkIn(row, `run-${i}`, { at: minute(i) }));
      await Promise.all(runs.map(run => finish(run.dispatchId)));
      expect((await f.store.findOne(row))?.noRecentUpdate, `round ${round}`).toMatchObject({ inARow: TASK_AUTO_PAUSE_AFTER_MISSES, autoPausedAt: expect.any(Date) });
      expect(lines.at(-1), `round ${round}`).toBe(pausedLine(row.routineId));
      expect(lines, `round ${round}`).toHaveLength(round + 1);
    }
  });

  it("an older check-in that finishes after a newer one reported doesn't count: the newer report stands", async () => {
    const lines = pauseLines();
    const row = await f.store.createAuthored(taskInput('task'));
    // A scheduled check-in is still running when the person presses Check now, which reports and finishes first.
    const scheduled = await checkIn(row, 'scheduled', { at: minute(1) });
    const checkNow = await checkIn(row, 'check-now', { at: minute(2), report: onTrack });
    await finish(checkNow.dispatchId);
    await finish(scheduled.dispatchId);
    expect((await f.store.findOne(row))?.noRecentUpdate).toBeNull();
    expect(await missColumns(row.routineId)).toEqual(NO_MISSES);
    // Nor is it the fifth miss once the newer one has reported, finished or not.
    const other = await f.store.createAuthored(taskInput('other'));
    await missed(other, TASK_AUTO_PAUSE_AFTER_MISSES - 1);
    const fifth = await checkIn(other, 'fifth', { at: minute(5) });
    const reporting = await checkIn(other, 'reporting', { at: minute(6), report: onTrack });
    await finish(fifth.dispatchId);
    expect(await f.store.findOne(other)).toMatchObject({ enabled: true, noRecentUpdate: { inARow: TASK_AUTO_PAUSE_AFTER_MISSES - 1 } });
    await finish(reporting.dispatchId);
    expect((await f.store.findOne(other))?.noRecentUpdate).toBeNull();
    expect(lines).toEqual([]);
  });

  it("an older check-in that reports after a newer one missed doesn't clear the miss", async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    const scheduled = await checkIn(row, 'scheduled', { at: minute(1) });
    const checkNow = await checkIn(row, 'check-now', { at: minute(2) });
    await finish(checkNow.dispatchId);
    const missedOnce = { inARow: 1, reason: 'no-report', at: checkNow.acceptedAt, autoPausedAt: null };
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual(missedOnce);
    expect(await f.store.recordReport({
      agentId: 'a', dispatchId: scheduled.dispatchId, conversationId: scheduled.conversationId, actorUserId: 'owner', report: onTrack, now: minute(3),
    })).toBe('recorded');
    await finish(scheduled.dispatchId);
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual(missedOnce);
  });

  it('an older check-in that reports after a newer one missed still ends the misses before it', async () => {
    const lines = pauseLines();
    const row = await f.store.createAuthored(taskInput('task'));
    const other = await f.store.createAuthored(taskInput('other'));
    await missed(row, 3);
    // A scheduled check-in that reports, beside a Check now that misses and finishes first.
    const older = await checkIn(row, 'older', { at: minute(4), report: onTrack });
    const newer = await checkIn(row, 'newer', { at: minute(5) });
    // Another task's misses are its own.
    await missed(other, 2, 5);
    await finish(newer.dispatchId, { status: 'error', error: 'boom', miss: 'brief-too-long' });
    expect((await f.store.findOne(row))?.noRecentUpdate?.inARow).toBe(4);
    await finish(older.dispatchId);
    // In the order they started: three misses, a report, a miss. So one in a row, with the newer miss's reason and start.
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual({ inARow: 1, reason: 'brief-too-long', at: newer.acceptedAt, autoPausedAt: null });
    // So the next miss is the second, and doesn't pause the task.
    await missed(row, 1, 6);
    expect(await f.store.findOne(row)).toMatchObject({ enabled: true, noRecentUpdate: { inARow: 2, reason: 'no-report', at: minute(6) } });
    expect(lines).toEqual([]);
  });

  it('a late report keeps only the misses that started after it: not one that started beside it and finished first, nor one a newer report answered', async () => {
    // A miss that starts in the same instant as a report and finishes first is answered by it (the test below).
    const row = await f.store.createAuthored(taskInput('task'));
    const reported = await checkIn(row, 'reported', { at: minute(4), report: onTrack });
    const beside = await checkIn(row, 'beside', { at: minute(4) });
    const newer = await checkIn(row, 'newer', { at: minute(5) });
    for (const run of [beside, newer, reported]) await finish(run.dispatchId);
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual({ inARow: 1, reason: 'no-report', at: newer.acceptedAt, autoPausedAt: null });
    // The second never counted: the third had reported when it finished. The first's late report doesn't bring it back.
    const other = await f.store.createAuthored(taskInput('other'));
    const first = await checkIn(other, 'first', { at: minute(4), report: onTrack });
    const second = await checkIn(other, 'second', { at: minute(5) });
    const third = await checkIn(other, 'third', { at: minute(6), report: onTrack });
    const fourth = await checkIn(other, 'fourth', { at: minute(7) });
    for (const run of [second, fourth, third, first]) await finish(run.dispatchId);
    expect((await f.store.findOne(other))?.noRecentUpdate).toEqual({ inARow: 1, reason: 'no-report', at: fourth.acceptedAt, autoPausedAt: null });
  });

  it('a late report behind a miss time with no missed check-in after it (a hand edit, a rollback) clears the misses, at boot too', async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    // A count below one beside a miss time is a hand edit too.
    for (const [i, inARow] of [2, -3].entries()) {
      await checkIn(row, `run-${i}`, { at: minute(i + 1), report: onTrack });
      await setMisses(row.routineId, { task_misses_in_a_row: inARow, task_miss_reason: 'failed', task_miss_at: minute(9) });
      await expect(f.store.interruptAbandonedDispatches(), String(inARow)).resolves.toBe(1);
      expect(await missColumns(row.routineId), String(inARow)).toEqual(NO_MISSES);
    }
  });

  it("a late report keeps a newer miss whose fire row holds only part of a report (a hand edit): that's no report, as history reads it", async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    const older = await checkIn(row, 'older', { at: minute(1), report: onTrack });
    const newer = await checkIn(row, 'newer', { at: minute(2) });
    await finish(newer.dispatchId);
    await sql`UPDATE routines_v1_fires SET report_status = 'on-track' WHERE dispatch_id = ${newer.dispatchId}`.execute(f.db);
    expect((await f.store.recentFires(row)).map(fire => fire.report)).toEqual([null]);
    await finish(older.dispatchId);
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual({ inARow: 1, reason: 'no-report', at: newer.acceptedAt, autoPausedAt: null });
  });

  it("an older check-in's miss counts behind a newer one's, which keeps its reason and start", async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    const first = await checkIn(row, 'first', { at: minute(1) });
    const second = await checkIn(row, 'second', { at: minute(2) });
    const third = await checkIn(row, 'third', { at: minute(3) });
    await finish(third.dispatchId, { status: 'error', error: 'boom', miss: 'brief-too-long' });
    await finish(first.dispatchId);
    const newest = { inARow: 2, reason: 'brief-too-long', at: third.acceptedAt, autoPausedAt: null };
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual(newest);
    // So the miss time never moves back, and a report from a check-in that started between the two can't
    // clear the newer miss. It ends the first's, though, which started before it, however early that finished.
    expect(await f.store.recordReport({
      agentId: 'a', dispatchId: second.dispatchId, conversationId: second.conversationId, actorUserId: 'owner', report: onTrack, now: minute(4),
    })).toBe('recorded');
    await finish(second.dispatchId);
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual({ ...newest, inARow: 1 });
  });

  it('check-ins that start in the same instant answer in the order they finish, as their reports do', async () => {
    // recordReport lets a report replace one from a run accepted in the same instant, so the last to finish answers.
    const row = await f.store.createAuthored(taskInput('task'));
    const reported = await checkIn(row, 'reported', { at: minute(1), report: onTrack });
    const quiet = await checkIn(row, 'quiet', { at: minute(1) });
    await finish(reported.dispatchId);
    await finish(quiet.dispatchId);
    expect((await f.store.findOne(row))?.noRecentUpdate).toEqual({ inARow: 1, reason: 'no-report', at: minute(1), autoPausedAt: null });
    const missing = await checkIn(row, 'missing', { at: minute(2) });
    const reporting = await checkIn(row, 'reporting', { at: minute(2), report: onTrack });
    await finish(missing.dispatchId);
    await finish(reporting.dispatchId);
    expect((await f.store.findOne(row))?.noRecentUpdate).toBeNull();
  });

  it("a report racing its own run's finish lands one consistent answer, and never deadlocks", async () => {
    for (let round = 0; round < 10; round++) {
      const row = await f.store.createAuthored(taskInput(`task-${round}`));
      const run = await checkIn(row, 'run', { at: minute(1) });
      const report = () => f.store.recordReport({ agentId: 'a', dispatchId: run.dispatchId, conversationId: run.conversationId, actorUserId: 'owner', report: onTrack, now: minute(2) });
      // Started together, the report usually takes the run's row first; every other round it waits a timer tick.
      const reporting = round % 2 === 0 ? report() : new Promise(resolve => setTimeout(resolve, 0)).then(report);
      const [recorded, finished] = await Promise.all([reporting, f.store.finishDispatch({ dispatchId: run.dispatchId, outcome: OK })]);
      expect(finished, `round ${round}`).toBe(true);
      expect(['recorded', 'run-closed'], `round ${round}`).toContain(recorded);
      // Recorded first, the run reported; finished first, the report came too late and the run left none.
      expect((await f.store.findOne(row))?.noRecentUpdate, `round ${round}`)
        .toEqual(recorded === 'recorded' ? null : { inARow: 1, reason: 'no-report', at: run.acceptedAt, autoPausedAt: null });
    }
  });
});
