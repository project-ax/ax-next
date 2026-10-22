import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql, type RawBuilder } from 'kysely';
import { makeAgentContext, type AgentContext, type HookBus, type ToolCall } from '@ax/core';
import { RoutineDefinitionSchema, type RoutineFireView, type RoutineListToolOutput, type RoutineView } from '@ax/routines-contract';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';

// TASK-907: routine_report, the tool a task's check-in reports with. Its input
// names no task, run or conversation. The host ties the call to the one open
// check-in in the session's own conversation, and only the host sets that: the
// IPC listener reads the person, the agent, the conversation and the source off
// the session row the runner's token resolves to. `runner` builds that context.

let h: RoutineHarness;
/** The agent's turn in the next check-in. `checkIn` sets it. */
let script: (ctx: AgentContext, bus: HookBus) => Promise<void> = async () => {};
afterEach(async () => { vi.restoreAllMocks(); script = async () => {}; await h?.close(); });
async function start(): Promise<void> {
  h = await createRoutineHarness({ invoke: async (ctx, bus) => { await script(ctx, bus); return { kind: 'complete' }; } });
}

const TASK = {
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
};
const REPEAT = { name: 'Daily', promptBody: 'Check outstanding work.', trigger: { kind: 'interval', every: '1h' } };
const NEEDS_YOU = { status: 'needs-you', update: 'Two tickets wait on a refund rule.', ask: 'Can refunds over $50 go out without you?' } as const;
const NOTES = 'Order 1234 waits on a refund.';
const NOT_IN_CHECK_IN = 'This works only during a task check-in. Field: input';
const INVALID = 'Routine input is invalid. Check the indicated field. Field: input';
const UNAVAILABLE = 'Routine management is temporarily unavailable. Field: input';

const create = (definition: Record<string, unknown>, requestId: string) => h.bus.call<unknown, RoutineView>('routines:create', h.owner, {
  agentId: h.agentId, requestId, definition: RoutineDefinitionSchema.parse(definition),
});
const get = (view: RoutineView) => h.bus.call<unknown, RoutineView>('routines:get', h.owner, { agentId: view.agentId, routineId: view.routineId });
const history = async (view: RoutineView) => (await h.bus.call<unknown, { fires: RoutineFireView[] }>(
  'routines:recent-fires', h.owner, { agentId: view.agentId, routineId: view.routineId })).fires;
const reportCall = (input: Record<string, unknown>): ToolCall => ({ id: 'report', name: 'routine_report', input });
const report = (ctx: AgentContext, call: ToolCall) => h.bus.call<ToolCall, unknown>('tool:execute:routine_report', ctx, call);
const failureOf = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

/**
 * The context a tool call from a check-in's runner reaches the host with, as the
 * IPC listener mints it: a fresh reqId, and the session's own person, agent,
 * conversation and source. `over` stands in for a session that differs.
 */
const runner = (ctx: AgentContext, over: { userId?: string; conversationId?: string } = {}): AgentContext => makeAgentContext({
  userId: ctx.userId, agentId: ctx.agentId, sessionId: 'check-in', conversationId: ctx.conversationId!, source: 'routine', ...over,
});

/**
 * One check-in of `view`, started with Check now: `body` runs as the agent's
 * turn, and the turn then ends the way a runner ends it. A failure inside the
 * turn fails the test. The harness answers every conversations:create with the
 * same id, so only one check-in may be open at a time.
 */
async function checkIn(view: RoutineView, requestId: string, body: (ctx: AgentContext, bus: HookBus) => Promise<void>): Promise<void> {
  let ended!: (failure: { error: unknown } | null) => void;
  const turn = new Promise<{ error: unknown } | null>(resolve => { ended = resolve; });
  script = async (ctx, bus) => {
    let failure: { error: unknown } | null = null;
    try { await body(ctx, bus); }
    catch (error) { failure = { error }; }
    finally {
      try { await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] }); }
      finally { ended(failure); }
    }
  };
  await h.bus.call('routines:fire-now', h.owner, { agentId: view.agentId, routineId: view.routineId, expectedRevision: view.revision, requestId });
  const failure = await turn;
  if (failure !== null) throw failure.error;
}

/** Every row holding any part of a report: a run's own copy, a task's state and notes, a history row's. */
async function written() {
  const ids = async (query: RawBuilder<{ id: string }>) => (await query.execute(h.db)).rows.map(row => row.id);
  return {
    dispatches: await ids(sql<{ id: string }>`SELECT dispatch_id AS id FROM routines_v1_dispatches WHERE report IS NOT NULL`),
    tasks: await ids(sql<{ id: string }>`SELECT routine_id AS id FROM routines_v1_definitions
      WHERE task_status IS NOT NULL OR task_update IS NOT NULL OR task_ask IS NOT NULL OR task_reported_at IS NOT NULL
        OR task_report_accepted_at IS NOT NULL OR agent_notes IS NOT NULL`),
    fires: await ids(sql<{ id: string }>`SELECT id::text AS id FROM routines_v1_fires
      WHERE report_status IS NOT NULL OR report_update IS NOT NULL OR report_ask IS NOT NULL`),
  };
}
const NOTHING = { dispatches: [], tasks: [], fires: [] };

describe('routine_report (TASK-907)', () => {
  it("a check-in's report lands on its run and its task", async () => {
    await start();
    const task = await create(TASK, 'task');
    const call = reportCall({ ...NEEDS_YOU, notes: NOTES });
    let answer: unknown;
    let hooks: string[] = [];
    await checkIn(task, 'run', async ctx => {
      const host = runner(ctx);
      // Pre-call runs the same checks, read-only: it lets the call through, nothing holds it, and it writes nothing.
      expect(await h.bus.fire('tool:pre-call', host, call)).toEqual({ rejected: false, payload: call });
      expect(await written()).toEqual(NOTHING);
      const calls = vi.spyOn(h.bus, 'call');
      answer = await report(host, call);
      hooks = calls.mock.calls.filter(([, callCtx]) => callCtx.reqId === host.reqId).map(([hook]) => hook);
      calls.mockRestore();
    });
    expect(answer).toStrictEqual({ recorded: true });
    // A report is the run's own output, not routine management: the tool asks
    // agents and decisions nothing, and calls the one writer of a task's state.
    expect(hooks).toEqual(['tool:execute:routine_report', 'routines:report']);
    const { task: state } = await get(task);
    expect(state).toEqual({ ...NEEDS_YOU, agentNotes: NOTES, reportedAt: expect.any(String) });
    expect(new Date(state!.reportedAt).toISOString()).toBe(state!.reportedAt);
    const fires = await history(task);
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ status: 'ok', report: NEEDS_YOU });
  });

  it('routine_list shows a task’s report without its notes, and routine_get shows both', async () => {
    await start();
    const task = await create(TASK, 'task');
    await checkIn(task, 'run', async ctx => { await report(runner(ctx), reportCall({ ...NEEDS_YOU, notes: NOTES })); });
    const chat = makeAgentContext({ ...h.owner, agentId: h.agentId, conversationId: 'chat' });
    const execute = <T,>(name: string, input: Record<string, unknown>) =>
      h.bus.call<ToolCall, T>(`tool:execute:${name}`, chat, { id: name, name, input });
    const shown = { status: 'needs-you', update: NEEDS_YOU.update, ask: NEEDS_YOU.ask, reportedAt: expect.any(String) };
    const list = await execute<RoutineListToolOutput>('routine_list', {});
    const listed = list.routines.find(row => row.routineId === task.routineId);
    expect(listed?.task).toEqual(shown);
    for (const key of ['agentNotes', 'notes']) expect(key in listed!.task!, key).toBe(false);
    expect(JSON.stringify(list)).not.toContain(NOTES);
    expect((await execute<RoutineView>('routine_get', { routineId: task.routineId })).task).toEqual({ ...shown, agentNotes: NOTES });
    // The service hook keeps them: the Tasks page reads them from there.
    expect((await h.bus.call<unknown, { routines: RoutineView[] }>('routines:list', h.owner, { agentId: h.agentId }))
      .routines.find(row => row.routineId === task.routineId)?.task?.agentNotes).toBe(NOTES);
  });

  it("routine_report refuses outside its own task's check-in, writing nothing", async () => {
    await start();
    const task = await create(TASK, 'task');
    const repeat = await create(REPEAT, 'repeat');
    const call = reportCall({ ...NEEDS_YOU, notes: NOTES });
    const refused: string[] = [];
    async function refuses(label: string, ctx: AgentContext): Promise<void> {
      await expect(report(ctx, call), label).rejects.toMatchObject({ toolCode: 'not-in-check-in', field: 'input' });
      // Pre-call refuses it the same way, so nothing holds it for approval either.
      expect(await h.bus.fire('tool:pre-call', ctx, call), label).toMatchObject({ rejected: true, source: '@ax/routines', reason: NOT_IN_CHECK_IN });
      expect(await written(), label).toEqual(NOTHING);
      refused.push(label);
    }
    await checkIn(task, 'task-run', async (ctx, bus) => {
      await refuses('a call naming another conversation', runner(ctx, { conversationId: 'elsewhere' }));
      await refuses("the run's conversation with no source",
        makeAgentContext({ userId: ctx.userId, agentId: ctx.agentId, sessionId: 'check-in', conversationId: ctx.conversationId! }));
      await refuses('an ordinary chat', makeAgentContext({ userId: ctx.userId, agentId: ctx.agentId, sessionId: 'chat', conversationId: 'chat' }));
      await refuses("someone other than the task's owner", runner(ctx, { userId: 'intruder' }));
      await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] });
      await refuses('a call after its turn ended', runner(ctx));
    });
    await checkIn(repeat, 'repeat-run', async ctx => {
      await refuses("a repeat routine's check-in", runner(ctx));
    });
    expect(refused).toHaveLength(6);
    // Both runs have their history rows, and neither has a report.
    expect((await history(task)).map(fire => fire.report)).toEqual([null]);
    expect((await history(repeat)).map(fire => fire.report)).toEqual([null]);
    expect((await get(task)).task).toBeNull();
    expect(await written()).toEqual(NOTHING);
    // The same call from the task's own check-in records: each refusal was about what it changed.
    await checkIn(task, 'control', async ctx => {
      expect(await report(runner(ctx), call)).toStrictEqual({ recorded: true });
    });
  });

  it('routine_report takes only its four fields', async () => {
    await start();
    const task = await create(TASK, 'task');
    const valid = { status: 'on-track', update: 'Queue is empty.', ask: null };
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['an input naming a routine', { ...valid, routineId: task.routineId }],
      ['an unknown key', { ...valid, steps: ['Answer ticket 1234'] }],
      ['an update of 501 characters', { ...valid, update: 'a'.repeat(501) }],
      ['an update with a line feed', { ...valid, update: 'Queue is empty.\nNothing waits.' }],
      ['an update with a carriage return', { ...valid, update: 'Queue is empty.\rNothing waits.' }],
      ['notes of 2,001 characters', { ...valid, notes: 'n'.repeat(2001) }],
      ['notes with a tag character', { ...valid, notes: 'Keep going.\u{E0049}' }],
    ];
    await checkIn(task, 'run', async ctx => {
      for (const [label, input] of invalid) {
        await expect(report(runner(ctx), reportCall(input)), label).rejects.toMatchObject({ toolCode: 'validation', field: 'input' });
        expect(await h.bus.fire('tool:pre-call', runner(ctx), reportCall(input)), label).toMatchObject({ rejected: true, reason: INVALID });
      }
      expect(await written()).toEqual(NOTHING);
      // At the caps exactly, it records.
      expect(await report(runner(ctx), reportCall({ ...valid, update: 'a'.repeat(500), notes: 'n'.repeat(2000) }))).toStrictEqual({ recorded: true });
    });
    expect((await get(task)).task).toMatchObject({ status: 'on-track', update: 'a'.repeat(500), ask: null, agentNotes: 'n'.repeat(2000) });
    expect((await history(task)).map(fire => fire.report)).toEqual([{ status: 'on-track', update: 'a'.repeat(500), ask: null }]);
  });

  it('notes are kept, cleared and replaced across reports in one check-in', async () => {
    await start();
    const task = await create(TASK, 'task');
    const reports = [
      { status: 'on-track', update: 'Queue is empty.', notes: 'A' },
      { status: 'on-track', update: 'Still empty.' },
      { status: 'off-track', update: 'Two tickets wait.', notes: null },
      { status: 'needs-you', update: 'A refund waits on you.', ask: 'Can I refund order 1234?', notes: 'B' },
    ];
    const notes: Array<string | null | undefined> = [];
    await checkIn(task, 'run', async ctx => {
      for (const input of reports) {
        expect(await report(runner(ctx), reportCall(input))).toStrictEqual({ recorded: true });
        notes.push((await get(task)).task?.agentNotes);
      }
    });
    expect(notes).toEqual(['A', 'A', null, 'B']);
    const last = { status: 'needs-you', update: 'A refund waits on you.', ask: 'Can I refund order 1234?' };
    expect((await get(task)).task).toMatchObject({ ...last, agentNotes: 'B' });
    // The run's history row carries its last report.
    expect((await history(task)).map(fire => fire.report)).toEqual([last]);
  });

  it('a database failure is "unavailable", and quotes nothing the agent sent', async () => {
    await start();
    const task = await create(TASK, 'task');
    const call = reportCall({ status: 'on-track', update: 'SECRET update', ask: 'SECRET ask?', notes: 'SECRET notes' });
    await checkIn(task, 'run', async ctx => {
      // The lookup fails: pre-call and the call itself both answer the closed "unavailable".
      await sql`ALTER TABLE routines_v1_dispatches RENAME TO report_tool_test_dispatches`.execute(h.db);
      try {
        const rejection = await h.bus.fire('tool:pre-call', runner(ctx), call);
        expect(rejection).toMatchObject({ rejected: true, reason: UNAVAILABLE });
        const error = await failureOf(report(runner(ctx), call));
        expect(error).toMatchObject({ toolCode: 'unavailable', field: 'input' });
        expect(inspect(error, { depth: 10, showHidden: true })).not.toContain('SECRET');
      } finally {
        await sql`ALTER TABLE report_tool_test_dispatches RENAME TO routines_v1_dispatches`.execute(h.db);
      }
      // The write fails: Postgres quotes the row it refused, and the tool passes none of it on.
      await sql`ALTER TABLE routines_v1_definitions ADD CONSTRAINT report_tool_test_refuses CHECK (task_update NOT LIKE 'SECRET%')`.execute(h.db);
      try {
        const error = await failureOf(report(runner(ctx), call));
        expect(error).toMatchObject({ toolCode: 'unavailable', field: 'input' });
        expect(inspect(error, { depth: 10, showHidden: true })).not.toContain('SECRET');
        expect(await written()).toEqual(NOTHING);
      } finally {
        await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT report_tool_test_refuses`.execute(h.db);
      }
    });
    expect((await history(task)).map(fire => fire.report)).toEqual([null]);
  });
});
