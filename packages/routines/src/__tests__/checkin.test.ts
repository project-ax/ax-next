import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAgentContext, type AgentContext, type ToolCall } from '@ax/core';
import { RoutineDefinitionSchema, type RoutineFireView, type RoutineListToolOutput, type RoutineView } from '@ax/routines-contract';
import { renderCheckInMessage } from '../checkin-message.js';
import { createRoutinesStore } from '../store.js';
import { createCheckInHarness, routineRunner, TASK_DEFINITION, type CheckInHarness } from './support/check-in.js';

// TASK-908: a task check-in, end to end through the real routines, agents,
// tool-policy and decisions plugins and Postgres. support/check-in.ts's invoke
// does what the orchestrator does, so what a test reads here is what a real
// check-in's agent would get.

let h: CheckInHarness;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); });

const REPEAT = { name: 'Daily', promptBody: 'Check outstanding work.', trigger: { kind: 'interval', every: '1h' } };
const NEEDS_YOU = { status: 'needs-you', update: 'Two tickets wait on a refund rule.', ask: 'Can refunds over $50 go out without you?' } as const;
const NOTES = 'Order 1234 waits on a refund.';

const create = (definition: object, requestId: string, agentId = h.agentId) => h.bus.call<unknown, RoutineView>('routines:create', h.owner, {
  agentId, requestId, definition: RoutineDefinitionSchema.parse(definition),
});
/** The agent's report, sent the way a check-in's runner sends it. */
const report = (ctx: AgentContext, input: Record<string, unknown>) =>
  h.bus.call<ToolCall, unknown>('tool:execute:routine_report', routineRunner(ctx), { id: 'report', name: 'routine_report', input });
/** A routine's run rows as stored, newest first. */
const storedRuns = (view: RoutineView) => createRoutinesStore(h.db).recentFires(view);

describe('the check-in message (TASK-908)', () => {
  it("a task's first check-in gets the check-in message, never its instructions", async () => {
    h = await createCheckInHarness();
    const task = await create(TASK_DEFINITION, 'task');
    const { message } = await h.checkIn(task, 'run', async () => {});
    expect(message).toBe(renderCheckInMessage({ source: 'manual', agentNotes: null, reports: [] }));
    expect(message).not.toContain(TASK_DEFINITION.promptBody);
    expect(message).not.toContain(TASK_DEFINITION.goodWhen);
  });

  it("the next check-in carries the agent's notes and its last report, fenced", async () => {
    h = await createCheckInHarness();
    const task = await create(TASK_DEFINITION, 'task');
    await h.checkIn(task, 'run-1', async ctx => {
      expect(await report(ctx, { ...NEEDS_YOU, notes: NOTES })).toStrictEqual({ recorded: true });
    });
    const { message } = await h.checkIn(task, 'run-2', async () => {});
    expect(message).toContain(`> ${NOTES}`);
    expect(message).toContain(`> ${NEEDS_YOU.update}`);
    expect(message).toContain('Your recent reports, newest first.');
    expect(message).not.toContain(NEEDS_YOU.ask);
    // Word for word: the task's notes and run 1's report, at the time run 1 started.
    const [, first] = await storedRuns(task);
    expect(message).toBe(renderCheckInMessage({ source: 'manual', agentNotes: NOTES, reports: [{ firedAt: first!.firedAt, report: NEEDS_YOU }] }));
  });

  it("a task run keeps no renderedPrompt; a repeat routine's is unchanged", async () => {
    h = await createCheckInHarness();
    const task = await create(TASK_DEFINITION, 'task');
    await h.checkIn(task, 'run-1', async ctx => { await report(ctx, { ...NEEDS_YOU, notes: NOTES }); });
    await h.checkIn(task, 'run-2', async () => {});
    expect((await storedRuns(task)).map(run => ({ status: run.status, renderedPrompt: run.renderedPrompt })))
      .toEqual([{ status: 'ok', renderedPrompt: null }, { status: 'ok', renderedPrompt: null }]);
    // A repeat routine's run starts with its instructions, byte for byte, and keeps them as its prompt.
    const repeat = await create(REPEAT, 'repeat');
    const { message } = await h.checkIn(repeat, 'repeat-run', async () => {});
    expect(message).toBe('Check outstanding work.');
    expect((await storedRuns(repeat)).map(run => ({ status: run.status, renderedPrompt: run.renderedPrompt })))
      .toEqual([{ status: 'ok', renderedPrompt: 'Check outstanding work.' }]);
  });

  it('a team agent’s check-in message reaches nobody but its owner', async () => {
    h = await createCheckInHarness();
    // The owner makes a task on the team agent, so it's theirs; the team's other people share the agent.
    const task = await create(TASK_DEFINITION, 'team-task', h.teamAgentId);
    await h.checkIn(task, 'run-1', async ctx => {
      expect(await report(ctx, { ...NEEDS_YOU, notes: NOTES })).toStrictEqual({ recorded: true });
    });
    const { message } = await h.checkIn(task, 'run-2', async () => {});
    // Run 2's message carried the owner's notes and run 1's update. That is the text that must go nowhere else.
    expect(message).toContain(`> ${NOTES}`);
    expect(message).toContain(`> ${NEEDS_YOU.update}`);
    const key = { agentId: h.teamAgentId, routineId: task.routineId };
    const chatOf = (person: AgentContext) => makeAgentContext({ ...person, agentId: h.teamAgentId, conversationId: `chat-${person.userId}` });
    const execute = <T,>(ctx: AgentContext, call: ToolCall) => h.bus.call<ToolCall, T>(`tool:execute:${call.name}`, ctx, call);
    /** Every read a person has of the task: the services (what Settings and the Tasks page serve) and the tools in their own chat. */
    async function reads(person: AgentContext) {
      const chat = chatOf(person);
      return {
        list: (await h.bus.call<unknown, { routines: RoutineView[] }>('routines:list', person, { agentId: h.teamAgentId })).routines,
        get: await h.bus.call<unknown, RoutineView>('routines:get', person, key),
        fires: (await h.bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires', person, key)).fires,
        agentFires: (await h.bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires-for-agent', person, { agentId: h.teamAgentId })).fires,
        listTool: await execute<RoutineListToolOutput>(chat, { id: 'list', name: 'routine_list', input: {} }),
        getTool: await execute<RoutineView>(chat, { id: 'get', name: 'routine_get', input: { routineId: task.routineId } }),
      };
    }
    for (const person of [h.teamMember, h.teamAdmin]) {
      const seen = await reads(person);
      // They see both runs, and neither run's check-in message: none was kept.
      for (const fires of [seen.fires, seen.agentFires]) expect(fires.map(fire => fire.renderedPrompt), person.userId).toEqual([null, null]);
      for (const text of [NOTES, NEEDS_YOU.update]) expect(JSON.stringify(seen), person.userId).not.toContain(text);
    }
    // The owner's history keeps no copy either: the message lives in the run's own conversation.
    const mine = await reads(h.owner);
    for (const fires of [mine.fires, mine.agentFires]) expect(fires.map(fire => fire.renderedPrompt)).toEqual([null, null]);
  });
});
