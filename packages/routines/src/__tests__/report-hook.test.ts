import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createLogger, HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { registerRoutineServices } from '../services.js';
import type { RoutinesStore } from '../store.js';

// TASK-907: `routines:report`, the one writer of a task's state. The bus is
// bare on purpose: the hook calls no other service (no agents:resolve, no
// agents:can-manage-routines), so calling one would fail these tests with
// no-service.
const f = fixture();
afterEach(() => { vi.restoreAllMocks(); });

const reportedAt = new Date(now.getTime() + 60_000);
const owner = makeAgentContext({ userId: 'owner', agentId: 'a', sessionId: 's' });
const needsYou = { status: 'needs-you', update: 'Two tickets wait on a refund rule.', ask: 'Can refunds over $50 go out without you?' } as const;
const NOTES = 'Order 1234 waits on a refund.';
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
/** An open run of `row`, bound to a conversation of its own the way fire.ts binds it. */
const bound = async (row: Key, requestId: string) => {
  const accepted = await accept(row, requestId);
  await f.store.bindDispatchConversation({ dispatchId: accepted.dispatchId, conversationId: `c-${requestId}` });
  return accepted;
};
const report = (bus: HookBus, input: Record<string, unknown>, ctx: AgentContext = owner) => bus.call<unknown, unknown>('routines:report', ctx, input);
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
    expect(await report(bus, { agentId: 'a', dispatchId: run.dispatchId, ...needsYou, notes: NOTES })).toStrictEqual({ recorded: true });
    // The task's state, stamped by the hook's own clock.
    expect((await f.store.findOne(row))?.task).toEqual({ ...needsYou, agentNotes: NOTES, reportedAt });
    // The run's report reaches its history row when the turn ends. The notes stay on the task.
    expect(await f.store.finishDispatch({ dispatchId: run.dispatchId, outcome })).toBe(true);
    expect((await f.store.recentFires(row)).map(fire => fire.report)).toEqual([needsYou]);
  });

  it('refuses with not-in-check-in, writing nothing', async () => {
    const bus = services();
    const task = await f.store.createAuthored(taskInput('task'));
    const repeat = await f.store.createAuthored(createInput('repeat'));
    const unbound = await accept(task, 'unbound');
    const finished = await bound(task, 'finished');
    expect(await f.store.finishDispatch({ dispatchId: finished.dispatchId, outcome })).toBe(true);
    const repeatRun = await bound(repeat, 'repeat-run');
    const open = await bound(task, 'open');
    const intruder = makeAgentContext({ userId: 'intruder', agentId: 'a', sessionId: 's' });
    const refused: Array<[string, Record<string, unknown>, AgentContext]> = [
      ['an unbound dispatch', { agentId: 'a', dispatchId: unbound.dispatchId }, owner],
      ['a finished dispatch', { agentId: 'a', dispatchId: finished.dispatchId }, owner],
      ["a repeat routine's dispatch", { agentId: 'a', dispatchId: repeatRun.dispatchId }, owner],
      ["someone other than the task's owner", { agentId: 'a', dispatchId: open.dispatchId }, intruder],
      ['another agent', { agentId: 'b', dispatchId: open.dispatchId }, owner],
      ['an unknown dispatch', { agentId: 'a', dispatchId: 'dispatch_unknown' }, owner],
    ];
    const before = await snapshot();
    for (const [label, target, ctx] of refused) {
      await expect(report(bus, { ...target, ...needsYou, notes: NOTES }, ctx), label).rejects.toMatchObject({ toolCode: 'not-in-check-in', field: 'input' });
    }
    expect(await snapshot()).toEqual(before);
    // The open run, reported by its owner, records: each refusal was about what it changed.
    expect(await report(bus, { agentId: 'a', dispatchId: open.dispatchId, ...needsYou })).toStrictEqual({ recorded: true });
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
      await expect(report(bus, input), label).rejects.toMatchObject({ toolCode: 'validation', field });
    }
    expect(await snapshot()).toEqual(before);
    expect(await report(bus, valid)).toStrictEqual({ recorded: true });
  });

  it('omitting notes keeps them; null clears them', async () => {
    const bus = services();
    const row = await f.store.createAuthored(taskInput('task'));
    const run = await bound(row, 'run');
    const base = { agentId: 'a', dispatchId: run.dispatchId, ...needsYou };
    const notes = async () => (await f.store.findOne(row))?.task?.agentNotes;
    await report(bus, { ...base, notes: NOTES });
    expect(await notes()).toBe(NOTES);
    await report(bus, base);
    expect(await notes()).toBe(NOTES);
    // Parsed, an explicit undefined is still a key. It's still "left out".
    await report(bus, { ...base, notes: undefined });
    expect(await notes()).toBe(NOTES);
    await report(bus, { ...base, notes: null });
    expect(await notes()).toBeNull();
  });

  it('a report the database refuses is an internal error naming only its run, tried once', async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    const run = await bound(row, 'run');
    const store = f.store;
    const recordReport = vi.fn(store.recordReport);
    const bus = services({ ...store, recordReport });
    const lines: string[] = [];
    const ctx = makeAgentContext({ userId: 'owner', agentId: 'a', sessionId: 's', logger: createLogger({ reqId: 'r', writer: line => { lines.push(line); } }) });
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
