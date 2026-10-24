import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql, type RawBuilder } from 'kysely';
import { makeAgentContext, type AgentContext, type HookBus, type ToolCall } from '@ax/core';
import { RoutineDefinitionSchema, type RoutineFireView, type RoutineListToolOutput, type RoutineView } from '@ax/routines-contract';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { expectOneFailure, expectOneRefusal, logged } from './support/report-log.js';
import { createRoutinesStore } from '../store.js';

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
/** TASK-952. A report's reading, as the agent sends it. */
const OPEN_3 = { value: 3, label: 'Open tickets' } as const;
const NOT_IN_CHECK_IN = 'This works only during a task check-in. Field: input';
const INVALID = (field: string) => `Routine input is invalid. Check the indicated field. Field: ${field}`;
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
    try {
      // TASK-908: what the orchestrator does before a fresh spawn's turn: ask routines' provider for the
      // brief, then fire chat:system-prompt-landed listing it when it answered one (a repeat routine's run
      // gets none). Skip either for a task and the veto refuses the run, or the belt fails it. Inside the
      // try, so a failed expect still ends the turn.
      const answer = await bus.call<unknown, { brief?: string }>('system-prompt:augment:optional:routines', ctx, {});
      const providers = answer.brief === undefined ? [] : ['system-prompt:augment:optional:routines'];
      expect(await bus.fire('chat:system-prompt-landed', ctx, { reqId: ctx.reqId, providers })).toMatchObject({ rejected: false });
      await body(ctx, bus);
    }
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

/** Every row holding any part of a report: a run's own copy, a task's state and notes, a history row's, and each one's reading (TASK-952). */
async function written() {
  const ids = async (query: RawBuilder<{ id: string }>) => (await query.execute(h.db)).rows.map(row => row.id);
  return {
    dispatches: await ids(sql<{ id: string }>`SELECT dispatch_id AS id FROM routines_v1_dispatches
      WHERE report IS NOT NULL OR report_reading_value IS NOT NULL OR report_reading_label IS NOT NULL`),
    tasks: await ids(sql<{ id: string }>`SELECT routine_id AS id FROM routines_v1_definitions
      WHERE task_status IS NOT NULL OR task_update IS NOT NULL OR task_ask IS NOT NULL OR task_reported_at IS NOT NULL
        OR task_report_accepted_at IS NOT NULL OR agent_notes IS NOT NULL
        OR task_reading_value IS NOT NULL OR task_reading_label IS NOT NULL OR task_reading_reported_at IS NOT NULL`),
    fires: await ids(sql<{ id: string }>`SELECT id::text AS id FROM routines_v1_fires
      WHERE report_status IS NOT NULL OR report_update IS NOT NULL OR report_ask IS NOT NULL
        OR report_reading_value IS NOT NULL OR report_reading_label IS NOT NULL`),
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
    expect(state).toEqual({ ...NEEDS_YOU, reading: null, agentNotes: NOTES, reportedAt: expect.any(String) });
    expect(new Date(state!.reportedAt).toISOString()).toBe(state!.reportedAt);
    const fires = await history(task);
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ status: 'ok', report: NEEDS_YOU });
  });

  it('routine_list shows a task’s report without its notes, and routine_get shows both', async () => {
    await start();
    const task = await create(TASK, 'task');
    await checkIn(task, 'run', async ctx => { await report(runner(ctx), reportCall({ ...NEEDS_YOU, notes: NOTES, reading: OPEN_3 })); });
    const chat = makeAgentContext({ ...h.owner, agentId: h.agentId, conversationId: 'chat' });
    const execute = <T,>(name: string, input: Record<string, unknown>) =>
      h.bus.call<ToolCall, T>(`tool:execute:${name}`, chat, { id: name, name, input });
    // TASK-952: both tools show the report's reading. Only the agent notes stay out of the list.
    const shown = { status: 'needs-you', update: NEEDS_YOU.update, ask: NEEDS_YOU.ask, reading: OPEN_3, reportedAt: expect.any(String) };
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

  it('routine_update answers with a task’s report but not its agent notes, live and replayed', async () => {
    await start();
    const task = await create(TASK, 'task');
    await checkIn(task, 'run', async ctx => { await report(runner(ctx), reportCall({ ...NEEDS_YOU, notes: NOTES })); });
    const chat = makeAgentContext({ ...h.owner, agentId: h.agentId, conversationId: 'chat' });
    const edit: ToolCall = { id: 'edit', name: 'routine_update', input: {
      requestId: 'edit', routineId: task.routineId, expectedRevision: (await get(task)).revision, patch: { description: 'Edited.' } } };
    // An edit that isn't the brief is held unless Always Allow: approve it once, the way a person would.
    await h.bus.fire('tool:pre-call', chat, edit);
    const { decisions } = await h.bus.call<unknown, { decisions: Array<{ id: string; call: ToolCall }> }>('decisions:list', chat, { userId: chat.userId });
    const held = decisions.find(decision => decision.call.input.requestId === 'edit')!;
    await h.bus.call('decisions:approve', chat, { decisionId: held.id, userId: chat.userId, approvalScope: 'once' });
    h.advance(11_000);
    const shown = { status: 'needs-you', update: NEEDS_YOU.update, ask: NEEDS_YOU.ask, reading: null, reportedAt: expect.any(String) };
    const answer = await h.bus.call<ToolCall, RoutineListToolOutput['routines'][number]>('tool:execute:routine_update', chat, edit);
    expect(answer).toMatchObject({ description: 'Edited.', task: shown });
    for (const key of ['agentNotes', 'notes']) expect(key in answer.task!, key).toBe(false);
    expect(JSON.stringify(answer)).not.toContain(NOTES);
    // An exact retry replays the edit's answer: still no notes.
    const replay = await h.bus.call<ToolCall, unknown>('tool:execute:routine_update', chat, edit);
    expect(replay).toMatchObject({ description: 'Edited.', revision: answer.revision });
    expect(JSON.stringify(replay)).not.toContain(NOTES);
    // routine_get still has them, for the work they're for.
    expect((await h.bus.call<ToolCall, RoutineView>('tool:execute:routine_get', chat, { id: 'get', name: 'routine_get', input: { routineId: task.routineId } }))
      .task?.agentNotes).toBe(NOTES);
  });

  it('a successful edit answers with what it did, and reads nothing once it has settled', async () => {
    await start();
    const task = await create(TASK, 'task');
    await checkIn(task, 'run', async ctx => { await report(runner(ctx), reportCall({ ...NEEDS_YOU, notes: NOTES })); });
    const chat = makeAgentContext({ ...h.owner, agentId: h.agentId, conversationId: 'chat' });
    const edit: ToolCall = { id: 'edit', name: 'routine_update', input: {
      requestId: 'edit', routineId: task.routineId, expectedRevision: (await get(task)).revision, patch: { description: 'Edited.' } } };
    await h.bus.fire('tool:pre-call', chat, edit);
    const { decisions } = await h.bus.call<unknown, { decisions: Array<{ id: string; call: ToolCall }> }>('decisions:list', chat, { userId: chat.userId });
    await h.bus.call('decisions:approve', chat, { decisionId: decisions.find(decision => decision.call.input.requestId === 'edit')!.id, userId: chat.userId, approvalScope: 'once' });
    h.advance(11_000);
    // Once the edit has settled, no routine can be read. An answer that still needed a read would call
    // an edit that happened "unavailable", and the agent would tell the person it failed.
    const callJoined = h.bus.callJoined.bind(h.bus);
    let settled = false;
    vi.spyOn(h.bus, 'callJoined').mockImplementation(async (hook: string, hookCtx: AgentContext, input: unknown) => {
      const result = await callJoined(hook, hookCtx, input);
      if (hook === 'decisions:settle-routine-call') {
        await sql`ALTER TABLE routines_v1_definitions RENAME TO report_tool_test_definitions`.execute(h.db);
        settled = true;
      }
      return result;
    });
    let answer: unknown;
    try { answer = await h.bus.call<ToolCall, unknown>('tool:execute:routine_update', chat, edit); }
    finally {
      vi.restoreAllMocks();
      if (settled) await sql`ALTER TABLE report_tool_test_definitions RENAME TO routines_v1_definitions`.execute(h.db);
    }
    expect(settled).toBe(true);
    expect(answer).toMatchObject({ description: 'Edited.', task: { status: 'needs-you', update: NEEDS_YOU.update, ask: NEEDS_YOU.ask, reportedAt: expect.any(String) } });
    expect(JSON.stringify(answer)).not.toContain(NOTES);
    expect((await get(task)).description).toBe('Edited.');
  });

  it("a team agent's task shows its state only to its owner, in the services and so in every tool", async () => {
    await start();
    // The owner makes a task on the team agent, so it's theirs; the team's other people share the agent.
    const task = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, {
      agentId: h.teamAgentId, requestId: 'team-task', definition: RoutineDefinitionSchema.parse(TASK) });
    await checkIn(task, 'run', async ctx => { await report(runner(ctx), reportCall({ ...NEEDS_YOU, notes: NOTES, reading: OPEN_3 })); });
    // TASK-930. Its missed check-ins are its state too: two since that report, set by hand as finishDispatch leaves them.
    const missedAt = new Date('2026-10-23T10:00:00.000Z');
    await h.db.updateTable('routines_v1_definitions').set({ task_misses_in_a_row: 2, task_miss_reason: 'no-report', task_miss_at: missedAt })
      .where('agent_id', '=', h.teamAgentId).where('routine_id', '=', task.routineId).execute();
    const key = { agentId: h.teamAgentId, routineId: task.routineId };
    const chatOf = (person: AgentContext) => makeAgentContext({ ...person, agentId: h.teamAgentId, conversationId: `chat-${person.userId}` });
    const execute = <T,>(ctx: AgentContext, call: ToolCall) => h.bus.call<ToolCall, T>(`tool:execute:${call.name}`, ctx, call);
    const mineOf = <V extends { routineId: string }>(views: V[]) => views.find(view => view.routineId === task.routineId);
    /**
     * Every read a person has of the task: the services, which the Settings routes (and the Tasks page)
     * serve as they are, and the tools in that person's own chat with the agent.
     */
    async function reads(person: AgentContext) {
      const chat = chatOf(person);
      return {
        list: mineOf((await h.bus.call<unknown, { routines: RoutineView[] }>('routines:list', person, { agentId: h.teamAgentId })).routines),
        get: await h.bus.call<unknown, RoutineView>('routines:get', person, key),
        fires: (await h.bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires', person, key)).fires,
        agentFires: (await h.bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires-for-agent', person, { agentId: h.teamAgentId })).fires,
        listTool: mineOf((await execute<RoutineListToolOutput>(chat, { id: 'list', name: 'routine_list', input: {} })).routines),
        getTool: await execute<RoutineView>(chat, { id: 'get', name: 'routine_get', input: { routineId: task.routineId } }),
      };
    }
    const shown = { status: 'needs-you', update: NEEDS_YOU.update, ask: NEEDS_YOU.ask, reading: OPEN_3, reportedAt: expect.any(String) };
    for (const person of [h.teamMember, h.teamAdmin]) {
      const seen = await reads(person);
      // The routine itself stays visible to them; only its task state, and each run's report, is the owner's.
      expect(seen.get, person.userId).toMatchObject({ routineId: task.routineId, name: TASK.name, kind: 'stay-on-top', task: null });
      for (const view of [seen.list, seen.listTool, seen.getTool]) expect(view?.task, person.userId).toBeNull();
      for (const view of [seen.list, seen.get, seen.listTool, seen.getTool]) expect(view?.noRecentUpdate, person.userId).toBeNull();
      for (const fires of [seen.fires, seen.agentFires]) expect(fires.map(fire => fire.report), person.userId).toEqual([null]);
      // TASK-952: the reading's label is the report's text too.
      for (const text of [NOTES, NEEDS_YOU.update, NEEDS_YOU.ask, OPEN_3.label]) expect(JSON.stringify(seen), person.userId).not.toContain(text);
    }
    // A team admin may stop someone else's task. The edit's answer shows none of its state either.
    const admin = chatOf(h.teamAdmin);
    const stop: ToolCall = { id: 'stop', name: 'routine_update', input: { requestId: 'stop', routineId: task.routineId, expectedRevision: task.revision, patch: { enabled: false } } };
    await h.bus.fire('tool:pre-call', admin, stop);
    const { decisions } = await h.bus.call<unknown, { decisions: Array<{ id: string; call: ToolCall }> }>('decisions:list', admin, { userId: admin.userId });
    await h.bus.call('decisions:approve', admin, { decisionId: decisions.find(decision => decision.call.input.requestId === 'stop')!.id, userId: admin.userId, approvalScope: 'once' });
    h.advance(11_000);
    const stopped = await execute<RoutineListToolOutput['routines'][number]>(admin, stop);
    expect(stopped).toMatchObject({ enabled: false, task: null, noRecentUpdate: null });
    for (const text of [NEEDS_YOU.update, OPEN_3.label]) expect(JSON.stringify(stopped)).not.toContain(text);
    // The owner sees all of it: the services carry the agent notes, routine_list leaves them out.
    const mine = await reads(h.owner);
    for (const view of [mine.list, mine.get, mine.getTool]) expect(view?.task).toEqual({ ...shown, agentNotes: NOTES });
    expect(mine.listTool?.task).toEqual(shown);
    // A person's stop isn't ax's pause, so the misses don't say autoPaused.
    const misses = { inARow: 2, reason: 'no-report', at: missedAt.toISOString(), autoPaused: false };
    for (const view of [mine.list, mine.get, mine.listTool, mine.getTool]) expect(view?.noRecentUpdate).toEqual(misses);
    for (const fires of [mine.fires, mine.agentFires]) expect(fires.map(fire => fire.report)).toEqual([{ ...NEEDS_YOU, reading: OPEN_3 }]);
  });

  it("a deleted team task's runs keep their reports hidden from everyone, its owner included", async () => {
    await start();
    const task = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, {
      agentId: h.teamAgentId, requestId: 'team-task', definition: RoutineDefinitionSchema.parse(TASK) });
    await checkIn(task, 'run', async ctx => { await report(runner(ctx), reportCall({ ...NEEDS_YOU, notes: NOTES })); });
    const key = { agentId: h.teamAgentId, routineId: task.routineId };
    const fires = async (person: AgentContext) => ({
      byRoutine: (await h.bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires', person, key)).fires,
      forAgent: (await h.bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires-for-agent', person, { agentId: h.teamAgentId })).fires,
    });
    // While the task exists, its owner sees the run's report.
    expect((await fires(h.owner)).byRoutine.map(fire => fire.report)).toEqual([{ ...NEEDS_YOU, reading: null }]);
    // Deleting removes the definition row and nothing else: the run's rows stay. With no
    // definition there is no owner to match, so nobody sees the report, the former owner included.
    await createRoutinesStore(h.db).deleteAuthored({ ...key, expectedRevision: (await get(task)).revision, actorUserId: h.owner.userId, requestId: 'delete', now: new Date() });
    for (const person of [h.teamMember, h.owner]) {
      const seen = await fires(person);
      for (const list of [seen.byRoutine, seen.forAgent]) {
        expect(list.length, person.userId).toBe(1);
        expect(list.map(fire => fire.report), person.userId).toEqual([null]);
      }
      expect(JSON.stringify(seen), person.userId).not.toContain(NEEDS_YOU.update);
    }
  });

  it('a failed lookup leaves one warn line for the operator, from pre-call and from the call: the ids and the database\'s words, none of the report', async () => {
    await start();
    const task = await create(TASK, 'task');
    const call = reportCall({ status: 'on-track', update: 'SECRET update', ask: 'SECRET ask?', notes: 'SECRET notes' });
    await checkIn(task, 'run', async ctx => {
      await sql`ALTER TABLE routines_v1_dispatches RENAME TO report_tool_test_dispatches`.execute(h.db);
      try {
        const expected = { level: 'warn', stage: 'lookup', agentId: ctx.agentId, conversationId: ctx.conversationId!, err: expect.stringMatching(/routines_v1_dispatches/) };
        const keys = ['level', 'ts', 'reqId', 'msg', 'stage', 'agentId', 'conversationId', 'err'];
        const lineOf = (lines: readonly string[]) => lines.map(line => JSON.parse(line) as Record<string, unknown>);
        const preCall = logged(runner(ctx));
        expect(await h.bus.fire('tool:pre-call', preCall.ctx, call)).toMatchObject({ rejected: true, reason: UNAVAILABLE });
        const execute = logged(runner(ctx));
        await expect(report(execute.ctx, call)).rejects.toMatchObject({ toolCode: 'unavailable', field: 'input' });
        for (const { lines } of [preCall, execute]) {
          expect(lineOf(lines)).toEqual([expect.objectContaining({ msg: 'routines_report_failed', ...expected })]);
          for (const key of Object.keys(lineOf(lines)[0]!)) expect(keys, key).toContain(key);
          expect(lines.join('\n')).not.toMatch(/SECRET/);
        }
      } finally {
        await sql`ALTER TABLE report_tool_test_dispatches RENAME TO routines_v1_dispatches`.execute(h.db);
      }
    });
  });

  it('a new task’s routine_create answer has no task state to show', async () => {
    await start();
    const chat = makeAgentContext({ ...h.owner, agentId: h.agentId, conversationId: 'chat' });
    const call: ToolCall = { id: 'create', name: 'routine_create', input: { requestId: 'new-task', definition: TASK } };
    await h.bus.fire('tool:pre-call', chat, call);
    const { decisions } = await h.bus.call<unknown, { decisions: Array<{ id: string; call: ToolCall }> }>('decisions:list', chat, { userId: chat.userId });
    await h.bus.call('decisions:approve', chat, { decisionId: decisions.find(decision => decision.call.input.requestId === 'new-task')!.id, userId: chat.userId, approvalScope: 'once' });
    h.advance(11_000);
    const created = await h.bus.call<ToolCall, RoutineView>('tool:execute:routine_create', chat, call);
    expect(created).toMatchObject({ kind: 'stay-on-top', task: null });
    // Its replay is the same answer.
    expect(await h.bus.call<ToolCall, RoutineView>('tool:execute:routine_create', chat, call)).toEqual(created);
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

  it('every refusal leaves one info line for the operator: a fixed reason and ids, none of the report', async () => {
    await start();
    const task = await create(TASK, 'task');
    const repeat = await create(REPEAT, 'repeat');
    const call = reportCall({ status: 'on-track', update: 'SECRET update', ask: 'SECRET ask?', notes: 'SECRET notes' });
    /** One refused call, at pre-call and at execute: each leaves its own line. */
    async function refused(label: string, ctx: AgentContext, reason: string): Promise<void> {
      const early = logged(ctx);
      expect(await h.bus.fire('tool:pre-call', early.ctx, call), label).toMatchObject({ rejected: true, reason: NOT_IN_CHECK_IN });
      expectOneRefusal(early.lines, { stage: 'tool', reason }, /SECRET/, `${label} (pre-call)`);
      const late = logged(ctx);
      await expect(report(late.ctx, call), label).rejects.toMatchObject({ toolCode: 'not-in-check-in' });
      expectOneRefusal(late.lines, { stage: 'tool', reason }, /SECRET/, `${label} (execute)`);
    }
    await checkIn(task, 'task-run', async ctx => {
      await refused('an ordinary chat', makeAgentContext({ userId: ctx.userId, agentId: ctx.agentId, sessionId: 'chat', conversationId: 'chat' }), 'no-source');
      await refused('a routine run with no conversation', makeAgentContext({ userId: ctx.userId, agentId: ctx.agentId, sessionId: 'check-in', source: 'routine' }), 'no-conversation');
      await refused('a conversation no run is in', runner(ctx, { conversationId: 'elsewhere' }), 'no-open-run');
      await refused("someone other than the task's owner", runner(ctx, { userId: 'intruder' }), 'wrong-owner');
      // A second open run in the same conversation: the lookup can't tell which one reports.
      const store = createRoutinesStore(h.db);
      const extra = (await store.acceptDispatch({ agentId: task.agentId, routineId: task.routineId, expectedRevision: task.revision, actorUserId: 'owner', source: 'manual', requestId: 'extra', now: new Date() }))!.accepted;
      await store.bindDispatchConversation({ dispatchId: extra.dispatchId, conversationId: ctx.conversationId! });
      await refused('two open runs in one conversation', runner(ctx), 'ambiguous');
      await store.finishDispatch({ dispatchId: extra.dispatchId, outcome: { status: 'ok', conversationId: null, error: null, renderedPrompt: null, warning: null } });
      // The run's own report records, and leaves no refusal line.
      const control = logged(runner(ctx));
      expect(await report(control.ctx, call)).toStrictEqual({ recorded: true });
      expect(control.lines).toEqual([]);
    });
    await checkIn(repeat, 'repeat-run', async ctx => { await refused("a repeat routine's check-in", runner(ctx), 'wrong-kind'); });
  });

  it('routine_report takes only its fields, and a refusal names the field', async () => {
    await start();
    const task = await create(TASK, 'task');
    const valid = { status: 'on-track', update: 'Queue is empty.', ask: null };
    const invalid: Array<[string, Record<string, unknown>, string]> = [
      ['an input naming a routine', { ...valid, routineId: task.routineId }, 'input'],
      ['an unknown key', { ...valid, steps: ['Answer ticket 1234'] }, 'input'],
      ['a status it doesn’t know', { ...valid, status: 'done' }, 'status'],
      ['an update of 501 characters', { ...valid, update: 'a'.repeat(501) }, 'update'],
      ['an update with a line feed', { ...valid, update: 'Queue is empty.\nNothing waits.' }, 'update'],
      ['an update with a carriage return', { ...valid, update: 'Queue is empty.\rNothing waits.' }, 'update'],
      ['a blank ask', { ...valid, ask: ' ' }, 'ask'],
      ['notes of 2,001 characters', { ...valid, notes: 'n'.repeat(2001) }, 'notes'],
      ['notes with a tag character', { ...valid, notes: 'Keep going.\u{E0049}' }, 'notes'],
      // TASK-952: a reading's refusal names the part that's wrong. Invisible inputs are built from code points.
      ['a reading that isn’t a finite number', { ...valid, reading: { value: Number.POSITIVE_INFINITY, label: 'Open tickets' } }, 'reading.value'],
      ['a reading past 1e12', { ...valid, reading: { value: 1e13, label: 'Open tickets' } }, 'reading.value'],
      ['a reading with a blank label', { ...valid, reading: { value: 3, label: ' ' } }, 'reading.label'],
      ['a reading label of 41 characters', { ...valid, reading: { value: 3, label: 'x'.repeat(41) } }, 'reading.label'],
      ['a reading label on two lines', { ...valid, reading: { value: 3, label: `Open${String.fromCharCode(0x0A)}tickets` } }, 'reading.label'],
      ['a reading label with a tag character', { ...valid, reading: { value: 3, label: `Open tickets${String.fromCodePoint(0xE0049)}` } }, 'reading.label'],
      ['a reading with another key', { ...valid, reading: { value: 3, label: 'Open tickets', unit: 'tickets' } }, 'reading'],
      ['a reading written as a sentence', { ...valid, reading: 'Open tickets: 3' }, 'reading'],
    ];
    await checkIn(task, 'run', async ctx => {
      for (const [label, input, field] of invalid) {
        // The fixed template and the field's name: the rule's own words ("An update is one line.") never reach the agent.
        await expect(report(runner(ctx), reportCall(input)), label).rejects.toMatchObject({ toolCode: 'validation', field, message: INVALID(field) });
        expect(await h.bus.fire('tool:pre-call', runner(ctx), reportCall(input)), label).toMatchObject({ rejected: true, reason: INVALID(field) });
      }
      expect(await written()).toEqual(NOTHING);
      // At the caps exactly, it records.
      expect(await report(runner(ctx), reportCall({ ...valid, update: 'a'.repeat(500), notes: 'n'.repeat(2000) }))).toStrictEqual({ recorded: true });
    });
    expect((await get(task)).task).toMatchObject({ status: 'on-track', update: 'a'.repeat(500), ask: null, agentNotes: 'n'.repeat(2000) });
    expect((await history(task)).map(fire => fire.report)).toEqual([{ status: 'on-track', update: 'a'.repeat(500), ask: null, reading: null }]);
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
    expect((await history(task)).map(fire => fire.report)).toEqual([{ ...last, reading: null }]);
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

  it('a failed write leaves one warn line for the operator: the run, its task and why, none of the report', async () => {
    await start();
    const task = await create(TASK, 'task');
    const call = reportCall({ status: 'on-track', update: 'SECRET update', ask: 'SECRET ask?', notes: 'SECRET notes' });
    await checkIn(task, 'run', async ctx => {
      const { run } = await createRoutinesStore(h.db).findOpenDispatchByConversation({ agentId: ctx.agentId, conversationId: ctx.conversationId! });
      const ids = { agentId: ctx.agentId, conversationId: ctx.conversationId!, dispatchId: run!.dispatchId, routineId: task.routineId };
      // The write fails, and Postgres quotes the row it refused. The line keeps the run's id and the SQLSTATE.
      await sql`ALTER TABLE routines_v1_definitions ADD CONSTRAINT report_tool_test_refuses CHECK (task_update NOT LIKE 'SECRET%')`.execute(h.db);
      try {
        const write = logged(runner(ctx));
        await expect(report(write.ctx, call)).rejects.toMatchObject({ toolCode: 'unavailable', field: 'input' });
        expectOneFailure(write.lines, ids, new RegExp(`dispatch ${run!.dispatchId} \\(SQLSTATE 23514\\)`), /SECRET/, 'a refused write');
      } finally {
        await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT report_tool_test_refuses`.execute(h.db);
      }
      // A failure before the write (here the agent fence's read) leaves the same line, in the database's own words.
      await sql`ALTER TABLE routines_v1_retired_agents RENAME TO report_tool_test_retired_agents`.execute(h.db);
      try {
        const fence = logged(runner(ctx));
        await expect(report(fence.ctx, call)).rejects.toMatchObject({ toolCode: 'unavailable', field: 'input' });
        expectOneFailure(fence.lines, ids, /routines_v1_retired_agents/, /SECRET/, 'a failed fence');
      } finally {
        await sql`ALTER TABLE report_tool_test_retired_agents RENAME TO routines_v1_retired_agents`.execute(h.db);
      }
      // A refusal isn't a failure: when the hook refuses (the task changed hands between the tool's lookup and the
      // write), it leaves its own refusal line and no failure line.
      const callThrough = h.bus.call.bind(h.bus);
      vi.spyOn(h.bus, 'call').mockImplementation(async (hook: string, hookCtx: AgentContext, input: unknown) => {
        if (hook === 'routines:report') await sql`UPDATE routines_v1_definitions SET owner_user_id = 'someone-else' WHERE routine_id = ${task.routineId}`.execute(h.db);
        return callThrough(hook, hookCtx, input);
      });
      try {
        const refused = logged(runner(ctx));
        await expect(report(refused.ctx, call)).rejects.toMatchObject({ toolCode: 'not-in-check-in' });
        expectOneRefusal(refused.lines, { stage: 'hook', reason: 'owner' }, /SECRET/, 'a refusal');
        expect(refused.lines.filter(line => (JSON.parse(line) as { msg?: string }).msg === 'routines_report_failed')).toEqual([]);
      } finally {
        vi.restoreAllMocks();
        await sql`UPDATE routines_v1_definitions SET owner_user_id = ${h.owner.userId} WHERE routine_id = ${task.routineId}`.execute(h.db);
      }
      expect(await written()).toEqual(NOTHING);
    });
  });
});
