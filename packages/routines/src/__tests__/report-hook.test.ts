import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createLogger, HookBus, makeAgentContext, PluginError, type AgentContext, type MakeAgentContextOptions } from '@ax/core';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { registerRoutineServices } from '../services.js';
import type { RoutinesStore } from '../store.js';
import { expectOneRefusal, logged } from './support/report-log.js';

// TASK-907: `routines:report`, the one writer of a task's state. The bus is
// bare on purpose: the hook calls no other service (no agents:resolve, no
// agents:can-manage-routines), so calling one would fail these tests with
// no-service.
const f = fixture();
afterEach(() => { vi.restoreAllMocks(); });

const reportedAt = new Date(now.getTime() + 60_000);
/** The context a check-in's runner reaches the host with: a routine run, in that run's own conversation. */
const checkInCtx = (conversationId: string, over: Partial<MakeAgentContextOptions> = {}): AgentContext =>
  makeAgentContext({ userId: 'owner', agentId: 'a', sessionId: 's', source: 'routine', conversationId, ...over });
const needsYou = { status: 'needs-you', update: 'Two tickets wait on a refund rule.', ask: 'Can refunds over $50 go out without you?' } as const;
const NOTES = 'Order 1234 waits on a refund.';
/** Matches the report's text below, which no log line may carry. */
const REPORT_TEXT = /refund|tickets|Order 1234/;
const outcome = { status: 'ok' as const, conversationId: 'c', error: null, renderedPrompt: 'ran', warning: null };
const taskInput = (requestId: string) => ({ ...createInput(requestId), definition: RoutineDefinitionSchema.parse({
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
}) });

function services(store: RoutinesStore = f.store): HookBus {
  const bus = new HookBus();
  registerRoutineServices({ bus, store, now: () => reportedAt });
  return bus;
}
type Key = { agentId: string; routineId: string; revision: string };
const accept = async (row: Key, requestId: string) => (await f.store.acceptDispatch({
  agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', source: 'manual', requestId, now,
}))!.accepted;
/** An open run of `row`, bound to a conversation of its own the way fire.ts binds it, and its runner's context. */
const bound = async (row: Key, requestId: string) => {
  const accepted = await accept(row, requestId);
  const conversationId = `c-${requestId}`;
  await f.store.bindDispatchConversation({ dispatchId: accepted.dispatchId, conversationId });
  return { ...accepted, conversationId, ctx: checkInCtx(conversationId) };
};
const report = (bus: HookBus, input: Record<string, unknown>, ctx: AgentContext) => bus.call<unknown, unknown>('routines:report', ctx, input);
const snapshot = async () => ({
  dispatches: (await sql`SELECT * FROM routines_v1_dispatches ORDER BY dispatch_id`.execute(f.db)).rows,
  definitions: (await sql`SELECT * FROM routines_v1_definitions ORDER BY routine_id`.execute(f.db)).rows,
  fires: (await sql`SELECT * FROM routines_v1_fires ORDER BY id`.execute(f.db)).rows,
});

describe('routines:report (TASK-907)', () => {
  it("records a bound check-in's report and answers exactly { recorded: true }", async () => {
    const bus = services();
    const row = await f.store.createAuthored(taskInput('task'));
    const run = await bound(row, 'run');
    expect(await report(bus, { agentId: 'a', dispatchId: run.dispatchId, ...needsYou, notes: NOTES }, run.ctx)).toStrictEqual({ recorded: true });
    // The task's state, stamped by the hook's own clock.
    expect((await f.store.findOne(row))?.task).toEqual({ ...needsYou, agentNotes: NOTES, reportedAt, reading: null });
    // The run's report reaches its history row when the turn ends. The notes stay on the task.
    expect(await f.store.finishDispatch({ dispatchId: run.dispatchId, outcome })).toBe(true);
    expect((await f.store.recentFires(row)).map(fire => fire.report)).toEqual([{ ...needsYou, reading: null }]);
  });

  it('refuses with not-in-check-in, writing nothing', async () => {
    const bus = services();
    const task = await f.store.createAuthored(taskInput('task'));
    const repeat = await f.store.createAuthored(createInput('repeat'));
    const unbound = await accept(task, 'unbound');
    const finished = await bound(task, 'finished');
    expect(await f.store.finishDispatch({ dispatchId: finished.dispatchId, outcome })).toBe(true);
    const repeatRun = await bound(repeat, 'repeat-run');
    const gone = await f.store.createAuthored(taskInput('gone'));
    const orphan = await bound(gone, 'orphan');
    await f.store.deleteAuthored({ agentId: 'a', routineId: gone.routineId, expectedRevision: gone.revision, actorUserId: 'owner', requestId: 'delete-gone', now });
    const open = await bound(task, 'open');
    // Each refusal leaves one info line naming why, under the run's locks, for the operator.
    const refused: Array<[string, Record<string, unknown>, AgentContext, string]> = [
      ['an unbound dispatch', { agentId: 'a', dispatchId: unbound.dispatchId }, checkInCtx('c-unbound'), 'not-bound'],
      ['a finished dispatch', { agentId: 'a', dispatchId: finished.dispatchId }, finished.ctx, 'run-closed'],
      ["a repeat routine's dispatch", { agentId: 'a', dispatchId: repeatRun.dispatchId }, repeatRun.ctx, 'kind'],
      ["a deleted task's open run", { agentId: 'a', dispatchId: orphan.dispatchId }, orphan.ctx, 'routine-gone'],
      ["someone other than the task's owner", { agentId: 'a', dispatchId: open.dispatchId }, checkInCtx(open.conversationId, { userId: 'intruder' }), 'owner'],
      ['another agent', { agentId: 'b', dispatchId: open.dispatchId }, checkInCtx(open.conversationId, { agentId: 'b' }), 'run-closed'],
      ['an unknown dispatch', { agentId: 'a', dispatchId: 'dispatch_unknown' }, open.ctx, 'run-closed'],
    ];
    const before = await snapshot();
    for (const [label, target, ctx, reason] of refused) {
      const log = logged(ctx);
      await expect(report(bus, { ...target, ...needsYou, notes: NOTES }, log.ctx), label).rejects.toMatchObject({ toolCode: 'not-in-check-in', field: 'input' });
      expectOneRefusal(log.lines, { stage: 'hook', reason }, REPORT_TEXT, label);
    }
    expect(await snapshot()).toEqual(before);
    // The open run, reported by its owner, records, and leaves no refusal line: each refusal was about what it changed.
    const control = logged(open.ctx);
    expect(await report(bus, { agentId: 'a', dispatchId: open.dispatchId, ...needsYou }, control.ctx)).toStrictEqual({ recorded: true });
    expect(control.lines).toEqual([]);
    // A retired agent's run refuses, even while its rows are still there.
    await sql`INSERT INTO routines_v1_retired_agents (agent_id) VALUES ('a')`.execute(f.db);
    const retired = logged(open.ctx);
    await expect(report(bus, { agentId: 'a', dispatchId: open.dispatchId, ...needsYou, notes: NOTES }, retired.ctx)).rejects.toMatchObject({ toolCode: 'not-in-check-in' });
    expectOneRefusal(retired.lines, { stage: 'hook', reason: 'agent-retired' }, REPORT_TEXT, 'a retired agent');
  });

  it("checks the whole binding itself: a routine run's context, in that run's own conversation", async () => {
    const bus = services();
    const task = await f.store.createAuthored(taskInput('task'));
    const run = await bound(task, 'run');
    // Another open check-in of the same task, in its own conversation.
    const sibling = await bound(task, 'sibling');
    const target = { agentId: 'a', dispatchId: run.dispatchId, ...needsYou, notes: NOTES };
    const refused: Array<[string, AgentContext, string]> = [
      ["another open check-in's conversation", sibling.ctx, 'not-bound'],
      ['a conversation no run is bound to', checkInCtx('c-elsewhere'), 'not-bound'],
      ["the run's conversation, from no routine run", makeAgentContext({ userId: 'owner', agentId: 'a', sessionId: 's', conversationId: run.conversationId }), 'no-source'],
      ["the run's conversation, from a person's chat", checkInCtx(run.conversationId, { source: 'user' }), 'no-source'],
      ['a routine run with no conversation', makeAgentContext({ userId: 'owner', agentId: 'a', sessionId: 's', source: 'routine' }), 'no-conversation'],
      ['a routine run with an empty conversation id', checkInCtx(''), 'no-conversation'],
      ["another agent's routine run, in the run's conversation", checkInCtx(run.conversationId, { agentId: 'b' }), 'not-bound'],
    ];
    const before = await snapshot();
    for (const [label, ctx, reason] of refused) {
      const log = logged(ctx);
      await expect(report(bus, target, log.ctx), label).rejects.toMatchObject({ toolCode: 'not-in-check-in', field: 'input' });
      expectOneRefusal(log.lines, { stage: 'hook', reason }, REPORT_TEXT, label);
    }
    expect(await snapshot()).toEqual(before);
    // The run's own check-in records: each refusal was about what it changed.
    expect(await report(bus, target, run.ctx)).toStrictEqual({ recorded: true });
  });

  it('validates its own input', async () => {
    const bus = services();
    const row = await f.store.createAuthored(taskInput('task'));
    const run = await bound(row, 'run');
    const valid = { agentId: 'a', dispatchId: run.dispatchId, ...needsYou };
    const { ask: _ask, ...noAsk } = valid;
    const invalid: Array<[string, Record<string, unknown>, string]> = [
      ['an extra routineId', { ...valid, routineId: row.routineId }, 'input'],
      ['an update on two lines', { ...valid, update: 'Queue is empty.\nNothing waits.' }, 'update'],
      ['a status it doesn’t know', { ...valid, status: 'done' }, 'status'],
      ['a missing ask', noAsk, 'ask'],
      ['blank notes', { ...valid, notes: '\n' }, 'notes'],
    ];
    const before = await snapshot();
    for (const [label, input, field] of invalid) {
      await expect(report(bus, input, run.ctx), label).rejects.toMatchObject({ toolCode: 'validation', field });
    }
    expect(await snapshot()).toEqual(before);
    expect(await report(bus, valid, run.ctx)).toStrictEqual({ recorded: true });
  });

  it('omitting notes keeps them; null clears them', async () => {
    const bus = services();
    const row = await f.store.createAuthored(taskInput('task'));
    const run = await bound(row, 'run');
    const base = { agentId: 'a', dispatchId: run.dispatchId, ...needsYou };
    const notes = async () => (await f.store.findOne(row))?.task?.agentNotes;
    await report(bus, { ...base, notes: NOTES }, run.ctx);
    expect(await notes()).toBe(NOTES);
    await report(bus, base, run.ctx);
    expect(await notes()).toBe(NOTES);
    // Parsed, an explicit undefined is still a key. It's still "left out".
    await report(bus, { ...base, notes: undefined }, run.ctx);
    expect(await notes()).toBe(NOTES);
    await report(bus, { ...base, notes: null }, run.ctx);
    expect(await notes()).toBeNull();
  });

  it('a reading reaches the task and the run; leaving it out or sending null means none this time (TASK-952)', async () => {
    const bus = services();
    const row = await f.store.createAuthored(taskInput('task'));
    const run = await bound(row, 'run');
    const base = { agentId: 'a', dispatchId: run.dispatchId, ...needsYou };
    const OPEN_3 = { value: 3, label: 'Open tickets' };
    const reading = async () => (await f.store.findOne(row))?.task?.reading;
    expect(await report(bus, { ...base, reading: OPEN_3 }, run.ctx)).toStrictEqual({ recorded: true });
    expect(await reading()).toEqual(OPEN_3);
    await report(bus, base, run.ctx);
    expect(await reading()).toBeNull();
    await report(bus, { ...base, reading: OPEN_3 }, run.ctx);
    await report(bus, { ...base, reading: null }, run.ctx);
    expect(await reading()).toBeNull();
    // The run keeps the reading its last report sent, for its history row.
    await report(bus, { ...base, reading: OPEN_3 }, run.ctx);
    expect(await f.store.finishDispatch({ dispatchId: run.dispatchId, outcome })).toBe(true);
    expect((await f.store.recentFires(row)).map(fire => fire.report)).toEqual([{ ...needsYou, reading: OPEN_3 }]);
  });

  it('a report the database refuses is an internal error naming only its run, tried once', async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    const run = await bound(row, 'run');
    const store = f.store;
    const recordReport = vi.fn(store.recordReport);
    const bus = services({ ...store, recordReport });
    const lines: string[] = [];
    const ctx = checkInCtx(run.conversationId, { logger: createLogger({ reqId: 'r', writer: line => { lines.push(line); } }) });
    // Postgres puts the row a CHECK refused in the error's detail, so this refusal quotes the report.
    await sql`ALTER TABLE routines_v1_definitions ADD CONSTRAINT report_hook_test_refuses CHECK (task_update NOT LIKE 'Refused%')`.execute(f.db);
    try {
      const before = await snapshot();
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write);
      const error = await report(bus, { agentId: 'a', dispatchId: run.dispatchId, status: 'on-track', update: 'Refused: the secret update.', ask: 'The secret ask?', notes: 'The secret notes.' }, ctx)
        .then(() => null, (e: unknown) => e);
      vi.restoreAllMocks();
      // Not a refusal the agent could act on, so nothing tells it the run isn't a check-in.
      expect(error).toBeInstanceOf(PluginError);
      expect(error).not.toHaveProperty('toolCode');
      expect((error as Error).message).toContain(`dispatch ${run.dispatchId} (SQLSTATE 23514)`);
      expect(inspect(error, { depth: 10, showHidden: true })).not.toMatch(/secret|Refused:/);
      expect(lines.join('')).not.toMatch(/secret|Refused:/);
      expect(recordReport).toHaveBeenCalledTimes(1);
      expect(await snapshot()).toEqual(before);
    } finally {
      await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT report_hook_test_refuses`.execute(f.db);
    }
  });
});
