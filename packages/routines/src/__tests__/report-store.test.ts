import { inspect } from 'node:util';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { sql } from 'kysely';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import type { DispatchReport, RecordReportInput } from '../types.js';

// TASK-907: a check-in's conversation, its report and the task's state. Task
// state isn't on StoredRoutine yet, so the rows are read with SQL.
const f = fixture();
afterEach(() => { vi.restoreAllMocks(); });

const later = new Date(now.getTime() + 60_000);
const CLOSED = 'The routine run closed before it could start.';
const onTrack = { status: 'on-track', update: 'Queue is empty.', ask: null } as const;
const needsYou = { status: 'needs-you', update: 'Two tickets need a refund decision.', ask: 'Can I refund order 1234?' } as const;
const outcome = { status: 'ok' as const, conversationId: 'c1', error: null, renderedPrompt: 'ran', warning: null };
const taskInput = (requestId: string) => ({ ...createInput(requestId), definition: RoutineDefinitionSchema.parse({
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
}) });
type Key = { agentId: string; routineId: string; revision: string };
const accept = async (row: Key, requestId: string, at = now) => (await f.store.acceptDispatch({
  agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', source: 'manual', requestId, now: at,
}))!.accepted;
const bound = async (row: Key, requestId: string, conversationId: string, at = now) => {
  const accepted = await accept(row, requestId, at);
  await f.store.bindDispatchConversation({ dispatchId: accepted.dispatchId, conversationId });
  return { ...accepted, conversationId };
};
/** A report from `run`'s own check-in: its conversation, or for a run that was never bound, one it would have had. */
const record = (run: { dispatchId: string; conversationId?: string }, over: Partial<RecordReportInput> = {}) =>
  f.store.recordReport({ agentId: 'a', dispatchId: run.dispatchId, conversationId: run.conversationId ?? 'c-unbound', actorUserId: 'owner', report: onTrack, now: later, ...over } as RecordReportInput);
const find = (agentId: string, conversationId: string) => f.store.findOpenDispatchByConversation({ agentId, conversationId });
const NO_OPEN_RUN = { run: null, reason: 'no-open-run' } as const;
const finish = (dispatchId: string) => f.store.finishDispatch({ dispatchId, outcome });

type DispatchRow = { conversation_id: string | null; report: unknown; accepted_at: Date; completed_at: Date | null };
const dispatchRow = async (dispatchId: string) =>
  (await sql<DispatchRow>`SELECT conversation_id, report, accepted_at, completed_at FROM routines_v1_dispatches WHERE dispatch_id = ${dispatchId}`.execute(f.db)).rows[0];
const taskRow = async (routineId: string) => (await sql<Record<string, unknown>>`
  SELECT task_status, task_update, task_ask, task_reported_at, task_report_accepted_at, agent_notes, revision, spec_hash, updated_at
    FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0];
const fireRow = async (dispatchId: string) => (await sql<Record<string, unknown>>`
  SELECT status, error, report_status, report_update, report_ask FROM routines_v1_fires WHERE dispatch_id = ${dispatchId}`.execute(f.db)).rows[0];
const fireReport = (report: { status: string; update: string; ask: string | null } | null) =>
  ({ report_status: report?.status ?? null, report_update: report?.update ?? null, report_ask: report?.ask ?? null });
const snapshot = async () => ({
  dispatches: (await sql`SELECT * FROM routines_v1_dispatches ORDER BY dispatch_id`.execute(f.db)).rows,
  definitions: (await sql`SELECT * FROM routines_v1_definitions ORDER BY routine_id`.execute(f.db)).rows,
  fires: (await sql`SELECT * FROM routines_v1_fires ORDER BY id`.execute(f.db)).rows,
});
const agentRows = async (agentId: string) => ({
  dispatches: (await sql`SELECT dispatch_id FROM routines_v1_dispatches WHERE agent_id = ${agentId}`.execute(f.db)).rows,
  definitions: (await sql`SELECT routine_id FROM routines_v1_definitions WHERE agent_id = ${agentId}`.execute(f.db)).rows,
  fires: (await sql`SELECT id FROM routines_v1_fires WHERE agent_id = ${agentId}`.execute(f.db)).rows,
});
const captureStderr = (): string[] => {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write);
  return lines;
};

describe("a check-in's conversation", () => {
  it('binds a dispatch to its conversation once, and only while it is open', async () => {
    const row = await f.store.createAuthored(taskInput('bind'));
    const run = await accept(row, 'bind-fire');
    await f.store.bindDispatchConversation({ dispatchId: run.dispatchId, conversationId: 'c1' });
    expect(await find('a', 'c1')).toEqual({ run: { dispatchId: run.dispatchId, routineId: row.routineId, kind: 'stay-on-top', ownerUserId: 'owner' } });
    await expect(f.store.bindDispatchConversation({ dispatchId: run.dispatchId, conversationId: 'c1' })).resolves.toBeUndefined();
    await expect(f.store.bindDispatchConversation({ dispatchId: run.dispatchId, conversationId: 'c2' })).rejects.toMatchObject({ message: CLOSED });
    expect((await dispatchRow(run.dispatchId))?.conversation_id).toBe('c1');
    expect(await find('a', 'c2')).toEqual(NO_OPEN_RUN);
    expect(await finish(run.dispatchId)).toBe(true);
    await expect(f.store.bindDispatchConversation({ dispatchId: run.dispatchId, conversationId: 'c1' })).rejects.toMatchObject({ message: CLOSED });
    expect(await find('a', 'c1')).toEqual(NO_OPEN_RUN);
    await expect(f.store.bindDispatchConversation({ dispatchId: 'dispatch_unknown', conversationId: 'c3' })).rejects.toMatchObject({ message: CLOSED });
    // A retired agent's run can't start, even while its row is still there.
    const open = await accept(row, 'retired-fire');
    await sql`INSERT INTO routines_v1_retired_agents (agent_id) VALUES ('a')`.execute(f.db);
    await expect(f.store.bindDispatchConversation({ dispatchId: open.dispatchId, conversationId: 'c4' })).rejects.toMatchObject({ message: CLOSED });
    expect((await dispatchRow(open.dispatchId))?.conversation_id).toBeNull();
  });

  it("finds no check-in when the conversation is ambiguous, another agent's or unknown, and says which", async () => {
    const row = await f.store.createAuthored(taskInput('ambiguous'));
    await bound(row, 'first', 'shared');
    await bound(row, 'second', 'shared');
    expect(await find('a', 'shared')).toEqual({ run: null, reason: 'ambiguous' });
    const solo = await bound(row, 'solo', 'solo');
    expect(await find('a', 'solo')).toMatchObject({ run: { dispatchId: solo.dispatchId } });
    expect(await find('b', 'solo')).toEqual(NO_OPEN_RUN);
    expect(await find('a', 'nope')).toEqual(NO_OPEN_RUN);
    // A run whose task was deleted is still open in its conversation: it keeps
    // the conversation ambiguous, and alone it has no task to report on.
    const gone = await f.store.createAuthored(taskInput('gone'));
    await bound(row, 'pair-kept', 'pair');
    await bound(gone, 'pair-gone', 'pair');
    await bound(gone, 'alone', 'alone');
    await f.store.deleteAuthored({ agentId: 'a', routineId: gone.routineId, expectedRevision: gone.revision, actorUserId: 'owner', requestId: 'delete-gone', now });
    expect(await find('a', 'pair')).toEqual({ run: null, reason: 'ambiguous' });
    expect(await find('a', 'alone')).toEqual({ run: null, reason: 'routine-gone' });
  });
});

describe("a check-in's report and the task's state", () => {
  it('records a report on the run and the task without changing its revision', async () => {
    const row = await f.store.createAuthored(taskInput('record'));
    const run = await bound(row, 'record-fire', 'c1');
    const before = await taskRow(row.routineId);
    expect(before).toMatchObject({ task_status: null, task_update: null, task_ask: null, task_reported_at: null, task_report_accepted_at: null, agent_notes: null });
    expect(await record(run, { report: needsYou, notes: 'Order 1234 waits on a refund.' })).toBe('recorded');
    const dispatch = await dispatchRow(run.dispatchId);
    expect(dispatch?.report).toEqual(needsYou);
    expect(await taskRow(row.routineId)).toEqual({
      ...before, task_status: 'needs-you', task_update: needsYou.update, task_ask: needsYou.ask,
      task_reported_at: later, task_report_accepted_at: dispatch?.accepted_at, agent_notes: 'Order 1234 waits on a refund.',
    });
    // An approval held with the pre-report revision still applies.
    await expect(f.store.updateAuthored({ agentId: 'a', routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner',
      requestId: 'after-report', patch: { description: 'After the report.' }, now: later, stopOnly: false })).resolves.toMatchObject({ description: 'After the report.' });
  });

  it("copies the run's report onto its fire row at turn end; a run without one gets none", async () => {
    const row = await f.store.createAuthored(taskInput('copy'));
    const run = await bound(row, 'copy-fire', 'c1');
    expect(await record(run, { report: needsYou })).toBe('recorded');
    expect(await finish(run.dispatchId)).toBe(true);
    expect(await fireRow(run.dispatchId)).toEqual({ status: 'ok', error: null, ...fireReport(needsYou) });
    expect(await dispatchRow(run.dispatchId)).toMatchObject({ report: null, completed_at: expect.any(Date) });
    const quiet = await bound(row, 'quiet-fire', 'c2');
    expect(await finish(quiet.dispatchId)).toBe(true);
    expect(await fireRow(quiet.dispatchId)).toEqual({ status: 'ok', error: null, ...fireReport(null) });
    // A check-in that didn't report leaves the task's state as it was.
    expect(await taskRow(row.routineId)).toMatchObject({ task_status: 'needs-you', task_update: needsYou.update });
  });

  it('a second report in the same check-in replaces the first', async () => {
    const row = await f.store.createAuthored(taskInput('replace'));
    const run = await bound(row, 'replace-fire', 'c1');
    const second = new Date(later.getTime() + 1000);
    expect(await record(run, { report: onTrack })).toBe('recorded');
    expect(await record(run, { report: needsYou, now: second })).toBe('recorded');
    expect((await dispatchRow(run.dispatchId))?.report).toEqual(needsYou);
    expect(await taskRow(row.routineId)).toMatchObject({ task_status: 'needs-you', task_update: needsYou.update, task_ask: needsYou.ask, task_reported_at: second });
    await finish(run.dispatchId);
    expect(await fireRow(run.dispatchId)).toMatchObject(fireReport(needsYou));
  });

  it('keeps, clears and replaces notes', async () => {
    const row = await f.store.createAuthored(taskInput('notes'));
    const run = await bound(row, 'notes-fire', 'c1');
    const notes = async () => (await taskRow(row.routineId))?.agent_notes;
    await record(run, { notes: 'A' });
    expect(await notes()).toBe('A');
    await record(run);
    expect(await notes()).toBe('A');
    // A key that's there but undefined is still "left out".
    await record(run, { notes: undefined });
    expect(await notes()).toBe('A');
    await record(run, { notes: null });
    expect(await notes()).toBeNull();
    await record(run, { notes: 'B' });
    expect(await notes()).toBe('B');
  });

  it("an older check-in's late report lands on its own run but never overwrites a newer one's task state", async () => {
    const row = await f.store.createAuthored(taskInput('two-runs'));
    const older = await bound(row, 'older', 'old', now);
    const newer = await bound(row, 'newer', 'new', new Date(now.getTime() + 1000));
    expect(await record(newer, { report: needsYou, notes: 'Newer notes.' })).toBe('recorded');
    expect(await record(older, { report: onTrack, notes: 'Older notes.', now: new Date(later.getTime() + 5000) })).toBe('recorded');
    const newerState = { task_status: 'needs-you', task_update: needsYou.update, task_ask: needsYou.ask, agent_notes: 'Newer notes.', task_reported_at: later, task_report_accepted_at: newer.acceptedAt };
    expect(await taskRow(row.routineId)).toMatchObject(newerState);
    expect((await dispatchRow(older.dispatchId))?.report).toEqual(onTrack);
    expect((await dispatchRow(newer.dispatchId))?.report).toEqual(needsYou);
    expect(await finish(newer.dispatchId)).toBe(true);
    expect(await finish(older.dispatchId)).toBe(true);
    expect(await fireRow(older.dispatchId)).toMatchObject(fireReport(onTrack));
    expect(await fireRow(newer.dispatchId)).toMatchObject(fireReport(needsYou));
    expect(await taskRow(row.routineId)).toMatchObject(newerState);
    // Reporting at the same moment, the run accepted later still owns the task.
    for (let i = 0; i < 3; i++) {
      const first = await bound(row, `race-old-${i}`, `race-old-${i}`, new Date(now.getTime() + 10_000 * (i + 1)));
      const second = await bound(row, `race-new-${i}`, `race-new-${i}`, new Date(now.getTime() + 10_000 * (i + 1) + 1000));
      await Promise.all([record(first, { report: onTrack }), record(second, { report: needsYou })]);
      expect(await taskRow(row.routineId)).toMatchObject({ task_status: 'needs-you', task_report_accepted_at: second.acceptedAt });
    }
  });

  it('refuses without writing', async () => {
    const task = await f.store.createAuthored(taskInput('refuse-task'));
    const repeat = await f.store.createAuthored(createInput('refuse-repeat'));
    const deleted = await f.store.createAuthored(taskInput('refuse-deleted'));
    const finished = await bound(task, 'finished', 'c-finished');
    expect(await finish(finished.dispatchId)).toBe(true);
    const unbound = await accept(task, 'unbound');
    const repeatRun = await bound(repeat, 'repeat-run', 'c-repeat');
    const orphan = await bound(deleted, 'orphan', 'c-orphan');
    await f.store.deleteAuthored({ agentId: 'a', routineId: deleted.routineId, expectedRevision: deleted.revision, actorUserId: 'owner', requestId: 'delete', now });
    const open = await bound(task, 'open', 'c-open');
    const sibling = await bound(task, 'sibling', 'c-sibling');
    const before = await snapshot();
    // Each refusal says why, in a fixed word an operator's log can carry.
    expect(await record(finished)).toBe('run-closed');
    expect(await record(unbound)).toBe('not-bound');
    expect(await record(repeatRun)).toBe('kind');
    expect(await record(orphan)).toBe('routine-gone');
    expect(await record(open, { actorUserId: 'intruder' })).toBe('owner');
    expect(await record({ dispatchId: 'dispatch_unknown', conversationId: open.conversationId })).toBe('run-closed');
    expect(await record(open, { agentId: 'b' })).toBe('run-closed');
    // The run, named from a conversation it isn't bound to: another open check-in's, or none's.
    expect(await record(open, { conversationId: sibling.conversationId })).toBe('not-bound');
    expect(await record(open, { conversationId: 'c-elsewhere' })).toBe('not-bound');
    expect(await snapshot()).toEqual(before);
    // The same run, asked properly, records: the refusals above were about what they changed.
    expect(await record(open)).toBe('recorded');
    // A retired agent's run refuses, even while its rows are still there.
    await sql`INSERT INTO routines_v1_retired_agents (agent_id) VALUES ('a')`.execute(f.db);
    const retired = await snapshot();
    expect(await record(open, { report: needsYou })).toBe('agent-retired');
    expect(await snapshot()).toEqual(retired);
  });

  it('a report and the turn end race to one consistent answer', async () => {
    const row = await f.store.createAuthored(taskInput('race'));
    for (let i = 0; i < 6; i++) {
      const run = await bound(row, `race-${i}`, `c-race-${i}`);
      const [recorded, finished] = await Promise.all([record(run, { report: needsYou }), finish(run.dispatchId)]);
      expect(finished).toBe(true);
      expect(['recorded', 'run-closed']).toContain(recorded);
      expect(await fireRow(run.dispatchId)).toMatchObject(fireReport(recorded === 'recorded' ? needsYou : null));
      expect(await dispatchRow(run.dispatchId)).toMatchObject({ report: null, completed_at: expect.any(Date) });
    }
  });

  it('a report racing an edit that changes the kind always ends the same way: a repeat routine holds no task state', async () => {
    const NO_STATE = { task_status: null, task_update: null, task_ask: null, task_reported_at: null, task_report_accepted_at: null, agent_notes: null };
    const toRepeat = (row: Key, requestId: string) => f.store.updateAuthored({ agentId: 'a', routineId: row.routineId, expectedRevision: row.revision,
      actorUserId: 'owner', requestId, patch: { kind: 'repeat', goodWhen: null }, now: later, stopOnly: false });
    // Each order on its own. The edit first: the report sees the new kind under the row lock and is refused.
    const editFirst = await f.store.createAuthored(taskInput('edit-first'));
    const editFirstRun = await bound(editFirst, 'edit-first-run', 'c-edit-first');
    await toRepeat(editFirst, 'edit-first-edit');
    expect(await record(editFirstRun, { report: needsYou, notes: 'Race notes.' })).toBe('kind');
    expect(await taskRow(editFirst.routineId)).toMatchObject(NO_STATE);
    // The report first: it lands, and the edit clears it in the same statement that changes the kind.
    const reportFirst = await f.store.createAuthored(taskInput('report-first'));
    const reportFirstRun = await bound(reportFirst, 'report-first-run', 'c-report-first');
    expect(await record(reportFirstRun, { report: needsYou, notes: 'Race notes.' })).toBe('recorded');
    await toRepeat(reportFirst, 'report-first-edit');
    expect(await taskRow(reportFirst.routineId)).toMatchObject(NO_STATE);
    // Raced: whichever takes the definition's row lock first, the same end state, and never a deadlock.
    // Started together, the report usually wins (the edit makes more round trips before it locks the
    // row); every other time the report waits one timer tick and the edit usually wins.
    for (let i = 0; i < 25; i++) {
      const row = await f.store.createAuthored(taskInput(`kind-race-${i}`));
      const run = await bound(row, `kind-race-run-${i}`, `c-kind-race-${i}`);
      const editing = toRepeat(row, `kind-race-edit-${i}`);
      const report = () => record(run, { report: needsYou, notes: 'Race notes.' });
      const reporting = i % 2 === 0 ? report() : new Promise(resolve => setTimeout(resolve, 0)).then(report);
      const [edited, recorded] = await Promise.all([editing, reporting]);
      expect(['recorded', 'kind'], `race ${i}`).toContain(recorded);
      expect(edited, `race ${i}`).toMatchObject({ kind: 'repeat', task: null });
      expect(await taskRow(row.routineId), `race ${i}`).toMatchObject({ ...NO_STATE, revision: edited.revision });
      // The run keeps its own report, for its history row, exactly when it landed first.
      expect((await dispatchRow(run.dispatchId))?.report, `race ${i}`).toEqual(recorded === 'recorded' ? needsYou : null);
      expect(await finish(run.dispatchId), `race ${i}`).toBe(true);
      expect(await fireRow(run.dispatchId), `race ${i}`).toMatchObject(fireReport(recorded === 'recorded' ? needsYou : null));
    }
  });

  it("a person's edit mid-check-in doesn't drop the report", async () => {
    const row = await f.store.createAuthored(taskInput('edit'));
    const run = await bound(row, 'edit-fire', 'c1');
    const edited = await f.store.updateAuthored({ agentId: 'a', routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner',
      requestId: 'edit', patch: { description: 'Edited.' }, now: later, stopOnly: false });
    expect(edited.revision).not.toBe(row.revision);
    expect(await record(run, { report: needsYou })).toBe('recorded');
    expect(await taskRow(row.routineId)).toMatchObject({ task_status: 'needs-you', task_update: needsYou.update, revision: edited.revision });
    await finish(run.dispatchId);
    expect(await fireRow(run.dispatchId)).toMatchObject(fireReport(needsYou));
  });

  it("a run still open across a kind round trip can report into the restarted task: it is a live check-in of the same routine", async () => {
    const row = await f.store.createAuthored(taskInput('round-trip'));
    const run = await bound(row, 'round-trip-fire', 'c1');
    const edit = (current: Key, requestId: string, patch: Record<string, unknown>) => f.store.updateAuthored({
      agentId: 'a', routineId: row.routineId, expectedRevision: current.revision, actorUserId: 'owner', requestId, patch, now: later, stopOnly: false });
    // R1 is open. The routine becomes a repeat routine and then a task again: the task starts over.
    const repeat = await edit(row, 'to-repeat', { kind: 'repeat', goodWhen: null });
    const again = await edit(repeat, 'to-task', { kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.' });
    expect(await taskRow(row.routineId)).toMatchObject({ task_status: null, task_update: null, task_report_accepted_at: null, agent_notes: null, revision: again.revision });
    // R1 never closed, and the task is a task again, so its report is accepted: the restarted task shows R1's report.
    expect(await record(run, { report: needsYou })).toBe('recorded');
    expect(await taskRow(row.routineId)).toMatchObject({ task_status: 'needs-you', task_update: needsYou.update, task_ask: needsYou.ask });
    await finish(run.dispatchId);
    expect(await fireRow(run.dispatchId)).toMatchObject(fireReport(needsYou));
  });

  it('a host restart after the report keeps it on the run', async () => {
    const row = await f.store.createAuthored(taskInput('restart'));
    const run = await bound(row, 'restart-fire', 'c1');
    expect(await record(run, { report: needsYou })).toBe('recorded');
    expect(await f.store.interruptAbandonedDispatches()).toBe(1);
    expect(await fireRow(run.dispatchId)).toEqual({ status: 'error', error: 'The routine run was interrupted by a host restart.', ...fireReport(needsYou) });
    expect(await dispatchRow(run.dispatchId)).toMatchObject({ report: null, completed_at: expect.any(Date) });
    expect(await taskRow(row.routineId)).toMatchObject({ task_status: 'needs-you' });
  });

  it('an agent deleted mid-check-in takes the report with it', async () => {
    const row = await f.store.createAuthored(taskInput('purge'));
    const run = await bound(row, 'purge-fire', 'c1');
    expect(await record(run, { notes: 'Remember the refund.' })).toBe('recorded');
    expect(await finish(run.dispatchId)).toBe(true);
    await f.store.purgeAgent('a');
    expect(await agentRows('a')).toEqual({ dispatches: [], definitions: [], fires: [] });
    const other = await f.store.createAuthored({ ...taskInput('purge-b'), agentId: 'b' });
    const late = await bound(other, 'late', 'c-late');
    await f.store.purgeAgent('b');
    expect(await f.store.recordReport({ agentId: 'b', dispatchId: late.dispatchId, conversationId: late.conversationId, actorUserId: 'owner', report: needsYou, notes: 'Too late.', now: later })).toBe('agent-retired');
    expect(await agentRows('b')).toEqual({ dispatches: [], definitions: [], fires: [] });
  });
});

describe("a stored report finishDispatch can't read", () => {
  it.each([
    ["a status it doesn't know", { status: 'done', update: 'Hidden words.', ask: null }],
    ['a missing field', { status: 'on-track', update: 'Hidden words.' }],
    ['an extra field', { status: 'on-track', update: 'Hidden words.', ask: null, notes: 'Hidden words.' }],
    ['a bare string', 'Hidden words.'],
  ])('is dropped, and the run still finishes at boot (%s)', async (_label, stored) => {
    const row = await f.store.createAuthored(taskInput('unreadable'));
    const run = await bound(row, 'unreadable-fire', 'c1');
    await sql`UPDATE routines_v1_dispatches SET report = ${JSON.stringify(stored)}::jsonb WHERE dispatch_id = ${run.dispatchId}`.execute(f.db);
    const lines = captureStderr();
    expect(await f.store.interruptAbandonedDispatches()).toBe(1);
    vi.restoreAllMocks();
    expect(lines.filter(line => line.startsWith('[ax/routines]'))).toEqual([`[ax/routines] dropped an unreadable report for dispatch ${run.dispatchId}\n`]);
    expect(lines.join('')).not.toContain('Hidden words');
    expect(await fireRow(run.dispatchId)).toMatchObject({ status: 'error', ...fireReport(null) });
    expect(await dispatchRow(run.dispatchId)).toMatchObject({ report: null, completed_at: expect.any(Date) });
  });

  it('a JSON null is no report, and says nothing', async () => {
    const row = await f.store.createAuthored(taskInput('json-null'));
    const run = await bound(row, 'json-null-fire', 'c1');
    await sql`UPDATE routines_v1_dispatches SET report = 'null'::jsonb WHERE dispatch_id = ${run.dispatchId}`.execute(f.db);
    const lines = captureStderr();
    expect(await finish(run.dispatchId)).toBe(true);
    vi.restoreAllMocks();
    expect(lines.filter(line => line.startsWith('[ax/routines]'))).toEqual([]);
    expect(await fireRow(run.dispatchId)).toMatchObject(fireReport(null));
  });
});

it('a report the database refuses fails naming only its run, and writes nothing', async () => {
  const row = await f.store.createAuthored(taskInput('refused'));
  const run = await bound(row, 'refused-fire', 'c1');
  const before = await snapshot();
  // A lone surrogate: JSON can carry one, and Postgres refuses it in a jsonb
  // column with an error that quotes the text. The contract refuses it first;
  // this is the store's own floor.
  const error = await record(run, { report: { status: 'on-track', update: 'Queue \uD800 is empty.', ask: null }, notes: 'Secret notes.' })
    .then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(`Could not save the report for dispatch ${run.dispatchId} (SQLSTATE 22P02).`);
  expect((error as Error).cause).toBeUndefined();
  expect(inspect(error, { depth: 10, showHidden: true })).not.toMatch(/Queue|Secret/);
  expect(await snapshot()).toEqual(before);
});

// TASK-908: the reports a task's next check-in message shows, read from the
// runs' own fire rows.
describe('recentReports (TASK-908)', () => {
  const offTrack = { status: 'off-track', update: 'Three tickets are past an hour.', ask: null } as const;
  const minute = (n: number) => new Date(now.getTime() + n * 60_000);
  /** A finished run of `row` accepted at `at`, with `report` on it, or with none when it's null. */
  const finished = async (row: Key, requestId: string, at: Date, report: DispatchReport | null) => {
    const run = await bound(row, requestId, `c-${requestId}`, at);
    if (report !== null) expect(await record(run, { report })).toBe('recorded');
    expect(await finish(run.dispatchId)).toBe(true);
  };
  const recent = (routineId: string, limit: number, agentId = 'a') => f.store.recentReports({ agentId, routineId, actorUserId: 'owner', limit });

  it('newest reported runs first, skipping runs without a report', async () => {
    const row = await f.store.createAuthored(taskInput('recent'));
    await finished(row, 'oldest', minute(1), onTrack);
    await finished(row, 'older', minute(2), offTrack);
    await finished(row, 'quiet', minute(3), null);
    await finished(row, 'newest', minute(4), needsYou);
    expect(await recent(row.routineId, 3)).toEqual([
      { firedAt: minute(4), report: needsYou },
      { firedAt: minute(2), report: offTrack },
      { firedAt: minute(1), report: onTrack },
    ]);
    // Two runs that started at the same moment: the one that finished last comes first.
    await finished(row, 'tie-first', minute(5), onTrack);
    await finished(row, 'tie-second', minute(5), offTrack);
    expect(await recent(row.routineId, 2)).toEqual([{ firedAt: minute(5), report: offTrack }, { firedAt: minute(5), report: onTrack }]);
  });

  it("only this routine's runs", async () => {
    const row = await f.store.createAuthored(taskInput('mine'));
    const other = await f.store.createAuthored(taskInput('other'));
    await finished(row, 'mine-run', minute(1), onTrack);
    await finished(other, 'other-run', minute(2), needsYou);
    expect(await recent(row.routineId, 3)).toEqual([{ firedAt: minute(1), report: onTrack }]);
    expect(await recent(row.routineId, 3, 'b')).toEqual([]);
  });

  it('limit is clamped', async () => {
    const row = await f.store.createAuthored(taskInput('clamp'));
    for (let i = 1; i <= 11; i++) await finished(row, `clamp-${i}`, minute(i), onTrack);
    expect((await recent(row.routineId, 0)).map(r => r.firedAt)).toEqual([minute(11)]);
    expect((await recent(row.routineId, 50)).map(r => r.firedAt)).toEqual(Array.from({ length: 10 }, (_, i) => minute(11 - i)));
  });
});

describe('isTaskConversation (TASK-908)', () => {
  const isTask = (agentId: string, conversationId: string) => f.store.isTaskConversation({ agentId, conversationId });

  it("a stay-on-top run's conversation is a task conversation, open and after it finished", async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    const run = await bound(row, 'task-fire', 'c-task');
    expect(await isTask('a', 'c-task')).toBe(true);
    expect(await finish(run.dispatchId)).toBe(true);
    expect(await isTask('a', 'c-task')).toBe(true);
  });

  it("a repeat routine's conversation is not", async () => {
    const row = await f.store.createAuthored(createInput('repeat'));
    const run = await bound(row, 'repeat-fire', 'c-repeat');
    expect(await isTask('a', 'c-repeat')).toBe(false);
    await finish(run.dispatchId);
    expect(await isTask('a', 'c-repeat')).toBe(false);
  });

  it('an unknown conversation, and the same id on another agent, are not', async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    await bound(row, 'task-fire', 'c-task');
    expect(await isTask('a', 'c-unknown')).toBe(false);
    expect(await isTask('b', 'c-task')).toBe(false);
  });

  it('a run whose routine was deleted still counts', async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    const run = await bound(row, 'task-fire', 'c-gone');
    await finish(run.dispatchId);
    await f.store.deleteAuthored({ agentId: 'a', routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', requestId: 'delete', now });
    expect(await f.store.findOne(row)).toBeNull();
    expect(await isTask('a', 'c-gone')).toBe(true);
  });
});
