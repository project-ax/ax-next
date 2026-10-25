import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { connectorsSkippedPayload } from '@ax/chat-orchestrator';
import { checkInBrief } from '../brief.js';
import { createFireRoutine, stashConnectorsSkipped, warningFor, type PendingFire, type PendingFires } from '../fire.js';
import { captureExpectedStderr } from './support/expected-diagnostics.js';
import { fixture, createInput, now } from './store-fixture.js';
import { purgeRoutineAgent } from '../cleanup.js';
import { renderCheckInMessage } from '../checkin-message.js';
import type { FireReport, StoredReply, StoredRoutine } from '../types.js';
const f = fixture();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });
function sampleRow(): StoredRoutine { return { ...createInput().definition, agentId: 'a', routineId: 'r', revision: 'v', ownerUserId: 'owner', definitionId: null, definitionUpdatedAt: null, nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null, lastWarning: null, task: null, noRecentUpdate: null, steps: [], finishBy: null, finishByTimeZone: null, done: null }; }
async function setup(options: {
  resolveError?: PluginError;
  invoke?: (ctx: AgentContext, bus: HookBus) => Promise<unknown>;
  grace?: number;
  definition?: object;
  bind?: () => Promise<void>;
  reports?: () => Promise<Array<{ firedAt: Date; report: FireReport }>>;
  replies?: (input: { agentId: string; routineId: string; actorUserId: string; limit: number }) => Promise<StoredReply[]>;
  /** TASK-951. The finish date the owner sets on the task before its run is accepted. */
  finishBy?: string;
  /** TASK-955. The time zone that date is set from. */
  finishByTimeZone?: string;
} = {}) {
  const row = await f.store.createAuthored({ ...createInput(), definition: RoutineDefinitionSchema.parse({ ...createInput().definition, ...options.definition }) });
  if (options.finishBy !== undefined) {
    const finishByTimeZone = options.finishByTimeZone ?? null;
    expect(await f.store.setFinishBy({ agentId: row.agentId, routineId: row.routineId, actorUserId: 'owner', finishBy: options.finishBy, finishByTimeZone }))
      .toEqual({ finishBy: options.finishBy, finishByTimeZone });
  }
  const accepted = (await f.store.acceptDispatch({ ...row, expectedRevision: row.revision, actorUserId: 'owner', requestId: 'fire', source: 'manual', now }))!.accepted;
  const bus = new HookBus();
  const pending: PendingFires = new Map();
  const invoked = vi.fn(async (ctx: AgentContext, _input?: unknown) => options.invoke ? options.invoke(ctx, bus) : { kind: 'complete' });
  const conversation = vi.fn(async () => ({ conversationId: 'c' }));
  const shared = vi.fn(async () => ({ conversation: { conversationId: 'c' }, created: false }));
  bus.registerService('agents:resolve', 'test', async () => { if (options.resolveError)
    throw options.resolveError; return { agent: { id: 'a', displayName: 'Bob' } }; });
  bus.registerService('agent:invoke', 'test', invoked);
  bus.registerService('conversations:create', 'test', conversation);
  bus.registerService('conversations:find-or-create', 'test', shared);
  bus.registerService('credentials:delete', 'test', async () => undefined);
  const store = { ...f.store, ...(options.bind ? { bindDispatchConversation: options.bind } : {}), ...(options.reports ? { recentReports: options.reports } : {}),
    ...(options.replies ? { recentReplies: options.replies } : {}) };
  const fire = createFireRoutine({ bus, pending, store, purgeAgent: agentId => purgeRoutineAgent({ bus, store: f.store, pending, agentId }), turnEndGraceMs: options.grace ?? 60000 });
  cleanups.push(async () => { pending.clear(); await fire.shutdown(); });
  return { bus, row, accepted, pending, invoked, conversation, shared, fire };
}
describe('accepted DB fire dispatch', () => {
  it('uses durable request identity and real execution owner, with routine origin and label', async () => {
    const h = await setup();
    const result = await h.fire(h.accepted);
    expect(result.recordedAtTurnEnd).toBe(true);
    expect(h.invoked.mock.calls[0]![0]).toMatchObject({ reqId: h.accepted.reqId, userId: 'owner', agentId: 'a', source: 'routine', triggerLabel: h.row.name });
    expect(h.pending.get(h.accepted.reqId)).toMatchObject({ dispatchId: h.accepted.dispatchId, agentName: 'Bob', skips: [], brief: 'waiting' });
    expect(await f.store.recentFires(h.row)).toEqual([]);
  });
  it('preserves shared conversation externalKey as the opaque routine identity', async () => {
    const h = await setup({ definition: { conversation: 'shared' } });
    await h.fire(h.accepted);
    expect(h.shared.mock.calls[0]).toBeDefined();
    expect(h.shared).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ externalKey: h.row.routineId }));
  });
  it('renders webhook payload once into the user prompt', async () => {
    const h = await setup({ definition: { promptBody: 'Review {{payload.title}}' } });
    await h.fire(h.accepted, { title: 'literal {{payload.title}}' });
    expect(h.pending.get(h.accepted.reqId)?.renderedPrompt).toBe('Review literal {{payload.title}}');
  });
  it('binds the run\'s conversation onto its dispatch before the agent is invoked', async () => {
    let seen: { run: { dispatchId: string } | null } | undefined;
    const h = await setup({ invoke: async ctx => { seen = await f.store.findOpenDispatchByConversation({ agentId: ctx.agentId, conversationId: ctx.conversationId! }); return { kind: 'complete' }; } });
    await h.fire(h.accepted);
    await expect.poll(() => seen).not.toBeUndefined();
    expect(seen?.run?.dispatchId).toBe(h.accepted.dispatchId);
    const bound = await sql<{ conversation_id: string | null }>`SELECT conversation_id FROM routines_v1_dispatches WHERE dispatch_id = ${h.accepted.dispatchId}`.execute(f.db);
    expect(bound.rows[0]?.conversation_id).toBe('c');
  });
  it('binds a shared conversation too', async () => {
    let seen: { run: { dispatchId: string } | null } | undefined;
    const h = await setup({ definition: { conversation: 'shared' }, invoke: async ctx => { seen = await f.store.findOpenDispatchByConversation({ agentId: ctx.agentId, conversationId: ctx.conversationId! }); return { kind: 'complete' }; } });
    await h.fire(h.accepted);
    await expect.poll(() => seen).not.toBeUndefined();
    expect(seen?.run?.dispatchId).toBe(h.accepted.dispatchId);
    const bound = await sql<{ conversation_id: string | null }>`SELECT conversation_id FROM routines_v1_dispatches WHERE dispatch_id = ${h.accepted.dispatchId}`.execute(f.db);
    expect(bound.rows[0]?.conversation_id).toBe('c');
  });
  it('a bind failure fails the fire before the agent runs', async () => {
    const h = await setup({ bind: async () => { throw new Error('database unavailable'); } });
    const result = await h.fire(h.accepted);
    expect(result).toMatchObject({ status: 'error', error: 'database unavailable', conversationId: null, renderedPrompt: null });
    expect(h.invoked).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
    expect(await f.store.recentFires(h.row)).toMatchObject([{ status: 'error', error: 'database unavailable' }]);
  });
  it.each(['forbidden', 'not-found'])('records %s from another provider without purging a live agent', async (code) => {
    const h = await setup({ resolveError: new PluginError({ code, plugin: 'teams', hookName: 'teams:is-member', message: 'denied' }) });
    expect((await h.fire(h.accepted)).status).toBe('error');
    expect(h.invoked).not.toHaveBeenCalled();
    expect(await f.store.findOne(h.row)).not.toBeNull();
    expect((await f.store.recentFires(h.row))[0]?.status).toBe('error');
  });
  it('purges only exact agents:resolve not-found, including pending correlations and HMAC cleanup', async () => {
    const h = await setup({ definition: { trigger: { kind: 'webhook', path: '/hook', hmac: { header: 'sig' } } }, resolveError: new PluginError({ code: 'not-found', plugin: 'agents', hookName: 'agents:resolve', message: 'gone' }) });
    h.pending.set('other', { row: h.row, dispatchId: 'other', conversationId: 'c', source: 'manual', renderedPrompt: 'p', agentName: null, skips: [], brief: 'waiting', acceptedAt: now, onTurnEnd: async () => { } });
    expect((await h.fire(h.accepted)).agentGone).toBe(true);
    expect(h.pending.size).toBe(0);
    expect(await f.store.findOne(h.row)).toBeNull();
    expect(await f.store.recentFires(h.row)).toEqual([]);
    expect(await f.store.pendingCleanup({ limit: 10 })).toEqual([]);
  });
  it.each(['throw', 'terminated', 'missing-turn'])('records exactly one terminal error for %s', async (kind) => {
    const h = await setup({ grace: 0, invoke: async () => { if (kind === 'throw')
        throw new Error('failed'); return { kind: kind === 'terminated' ? 'terminated' : 'complete', reason: 'stopped' }; } });
    const diagnostic = captureExpectedStderr(message => message.startsWith(`[ax/routines] agent:invoke failed for a/${h.row.routineId}:`));
    await h.fire(h.accepted);
    await expect.poll(async () => (await f.store.recentFires(h.row)).length).toBe(1);
    expect((await f.store.recentFires(h.row))[0]?.status).toBe('error');
    expect(diagnostic.messages).toHaveLength(1);
    expect(h.pending.size).toBe(0);
    expect(await f.store.finishDispatch({ dispatchId: h.accepted.dispatchId, outcome: { status: 'ok', error: null, conversationId: 'c', renderedPrompt: 'p', warning: null } })).toBe(false);
  });
  it('records a connector warning once when a dispatched invocation terminates', async () => {
    const h = await setup({ invoke: async (ctx) => { stashConnectorsSkipped(h.pending, { reqId: ctx.reqId, connectors: [{ connectorId: 'gmail', name: 'Gmail', reason: 'not-signed-in' }] }); return { kind: 'terminated', reason: 'runner' }; } });
    const diagnostic = captureExpectedStderr(message => message.startsWith(`[ax/routines] agent:invoke failed for a/${h.row.routineId}:`));
    await h.fire(h.accepted);
    await expect.poll(async () => (await f.store.recentFires(h.row)).length).toBe(1);
    expect(diagnostic.messages).toHaveLength(1);
    expect((await f.store.recentFires(h.row))[0]?.warning).toContain("Gmail isn't signed in on Bob");
  });
  it('finishes an accepted dispatch after routine deletion without resurrecting the definition', async () => {
    const h = await setup();
    await h.fire(h.accepted);
    await f.store.deleteAuthored({ ...h.row, expectedRevision: h.row.revision, actorUserId: 'owner', requestId: 'delete', now });
    expect(await f.store.finishDispatch({ dispatchId: h.accepted.dispatchId, outcome: { status: 'ok', error: null, conversationId: 'c', renderedPrompt: 'p', warning: null } })).toBe(true);
    expect(await f.store.findOne(h.row)).toBeNull();
    expect(await f.store.recentFires(h.row)).toHaveLength(1);
  });
  // TASK-908: `system-prompt:` is the landed veto's, fired before connector assembly too. A repeat
  // routine's run keeps the raw reason as its error; only a task's is worded (checkin.test.ts).
  it.each(['chat:start:denied', 'agent-resolve:forbidden', 'system-prompt:brief-missing'])('preserves the previous warning for a pre-assembly gate %s', async (reason) => {
    const h = await setup({ invoke: async () => ({ kind: 'terminated', reason }) });
    await f.store.finishDispatch({ dispatchId: h.accepted.dispatchId, outcome: { status: 'ok', conversationId: 'c', error: null, renderedPrompt: 'p', warning: 'Previous warning' } });
    const next = (await f.store.acceptDispatch({ ...h.row, expectedRevision: h.row.revision, actorUserId: 'owner', requestId: 'second', source: 'manual', now: new Date(now.getTime() + 1) }))!.accepted;
    const diagnostic = captureExpectedStderr(message => message.startsWith(`[ax/routines] agent:invoke failed for a/${h.row.routineId}: terminated: ${reason}`));
    await h.fire(next);
    await expect.poll(async () => (await f.store.recentFires(h.row)).length).toBe(2);
    expect((await f.store.recentFires(h.row))[0]).toMatchObject({ status: 'error', error: `terminated: ${reason}`, warning: 'Previous warning' });
    expect(diagnostic.messages).toHaveLength(1);
  });
  it('marks abandoned accepted work interrupted on startup without reinvocation', async () => {
    const h = await setup();
    expect(await f.store.interruptAbandonedDispatches()).toBe(1);
    expect(await f.store.interruptAbandonedDispatches()).toBe(0);
    expect(h.invoked).not.toHaveBeenCalled();
    expect((await f.store.recentFires(h.row))[0]).toMatchObject({ status: 'error', error: expect.stringContaining('interrupted') });
  });
});
// TASK-908: a task run starts with its check-in message instead of its
// instructions, and no run of a task keeps that message as its prompt. A repeat
// routine's run is exactly what it was.
describe('the check-in message and the stored prompt (TASK-908)', () => {
  const TASK = { kind: 'stay-on-top', goodWhen: 'All good.', trigger: { kind: 'interval', every: '15m' }, silenceToken: null, conversation: 'per-fire' };
  it("a task run's pending entry keeps no renderedPrompt and its invoke gets the check-in message", async () => {
    const h = await setup({ definition: TASK });
    const result = await h.fire(h.accepted);
    expect(h.pending.get(h.accepted.reqId)!.renderedPrompt).toBeNull();
    expect(h.invoked.mock.calls[0]![1]).toEqual({ message: { role: 'user', content: renderCheckInMessage({ source: 'manual', agentNotes: null, reports: [], replies: [], missesInARow: 0, steps: null, doneClaimed: false }) } });
    expect(result).toMatchObject({ status: 'ok', renderedPrompt: null, recordedAtTurnEnd: true });
  });
  // TASK-931: the person's replies on the task reach the run only in its check-in message.
  it('a task run reads its 20 latest replies into its check-in message', async () => {
    const replies = vi.fn(async (): Promise<StoredReply[]> => [
      { replyId: 'reply_1', authorUserId: 'owner', text: 'Refunds under $100 are fine.', sentAt: new Date('2030-12-31T23:00:00Z') },
    ]);
    const h = await setup({ definition: TASK, replies });
    await h.fire(h.accepted);
    // Read for the person the check-in runs as, the accepted row's owner: the store answers only while the task is still theirs.
    expect(replies.mock.calls).toEqual([[{ agentId: 'a', routineId: h.row.routineId, actorUserId: 'owner', limit: 20 }]]);
    const message = (h.invoked.mock.calls[0]![1] as { message: { content: string } }).message.content;
    expect(message).toContain('- 2030-12-31 23:00 UTC (new since your last report):\n  > Refunds under $100 are fine.');
    expect(message).not.toContain('reply_1');
  });
  it('a failed replies read fails the task run before the agent starts, as a missed check-in', async () => {
    const h = await setup({ definition: TASK, replies: async () => { throw new Error('database unavailable'); } });
    const result = await h.fire(h.accepted);
    expect(result).toMatchObject({ status: 'error', error: 'database unavailable', conversationId: null, renderedPrompt: null });
    expect(h.invoked).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
    expect(await f.store.recentFires(h.row)).toMatchObject([{ status: 'error', error: 'database unavailable', renderedPrompt: null }]);
    expect((await f.store.findOne(h.row))?.noRecentUpdate).toMatchObject({ inARow: 1, reason: 'failed' });
  });
  it('a failed report read fails the task run before the agent starts', async () => {
    const h = await setup({ definition: TASK, reports: async () => { throw new Error('database unavailable'); } });
    const result = await h.fire(h.accepted);
    expect(result).toMatchObject({ status: 'error', error: 'database unavailable', conversationId: null, renderedPrompt: null });
    expect(h.invoked).not.toHaveBeenCalled();
    expect(h.pending.size).toBe(0);
    expect(await f.store.recentFires(h.row)).toMatchObject([{ status: 'error', error: 'database unavailable', renderedPrompt: null }]);
  });
  it('a failed report read counts as a missed check-in, as failed', async () => {
    const h = await setup({ definition: TASK, reports: async () => { throw new Error('database unavailable'); } });
    await h.fire(h.accepted);
    expect((await f.store.findOne(h.row))?.noRecentUpdate).toMatchObject({ inARow: 1, reason: 'failed' });
  });
  it.each([
    ['system-prompt:brief-too-long', 'brief-too-long'],
    ['system-prompt:brief-missing', 'brief-missing'],
    ['system-prompt:other', 'failed'],
    ['chat:start:quota', 'failed'],
  ])('a task run the orchestrator ended as %s is recorded as %s', async (reason, miss) => {
    const h = await setup({ definition: TASK, invoke: async () => ({ kind: 'terminated', reason }) });
    const diagnostic = captureExpectedStderr(message => message.startsWith(`[ax/routines] agent:invoke failed for a/${h.row.routineId}:`));
    await h.fire(h.accepted);
    await expect.poll(async () => (await f.store.recentFires(h.row)).length).toBe(1);
    expect(diagnostic.messages).toHaveLength(1);
    expect((await f.store.findOne(h.row))?.noRecentUpdate).toMatchObject({ inARow: 1, reason: miss });
  });
  it.each(['throw', 'terminated', 'missing-turn'])('a task run that never finishes its turn keeps no renderedPrompt either (%s)', async (kind) => {
    const h = await setup({ definition: TASK, grace: 0, invoke: async () => { if (kind === 'throw')
        throw new Error('failed'); return { kind: kind === 'terminated' ? 'terminated' : 'complete', reason: 'stopped' }; } });
    const diagnostic = captureExpectedStderr(message => message.startsWith(`[ax/routines] agent:invoke failed for a/${h.row.routineId}:`));
    await h.fire(h.accepted);
    await expect.poll(async () => (await f.store.recentFires(h.row)).length).toBe(1);
    expect((await f.store.recentFires(h.row))[0]).toMatchObject({ status: 'error', renderedPrompt: null });
    expect(diagnostic.messages).toHaveLength(1);
  });
  it.each([
    { from: 'fire-now or the tick', definition: {}, payload: undefined, prompt: '  first line\n\nsecond line\n' },
    { from: 'a webhook', definition: { promptBody: 'Review {{payload.title}}' }, payload: { title: 'literal {{payload.title}}' }, prompt: 'Review literal {{payload.title}}' },
  ])("a repeat routine's run from $from is unchanged: its instructions, byte for byte, are its message and its prompt, and it reads no reports or replies", async ({ definition, payload, prompt }) => {
    const reports = vi.fn(async (): Promise<Array<{ firedAt: Date; report: FireReport }>> => { throw new Error('a repeat run must not read reports'); });
    const replies = vi.fn(async (): Promise<StoredReply[]> => { throw new Error('a repeat run must not read replies'); });
    const h = await setup({ definition, reports, replies });
    const result = await h.fire(h.accepted, payload);
    expect(h.invoked.mock.calls[0]![1]).toEqual({ message: { role: 'user', content: prompt } });
    expect(h.pending.get(h.accepted.reqId)!.renderedPrompt).toBe(prompt);
    expect(result).toMatchObject({ status: 'ok', renderedPrompt: prompt, recordedAtTurnEnd: true });
    expect(reports).not.toHaveBeenCalled();
    expect(replies).not.toHaveBeenCalled();
  });
  it("a repeat routine's run whose turn never ends still records its instructions as its prompt", async () => {
    const h = await setup({ grace: 0, invoke: async () => ({ kind: 'terminated', reason: 'stopped' }) });
    const diagnostic = captureExpectedStderr(message => message.startsWith(`[ax/routines] agent:invoke failed for a/${h.row.routineId}:`));
    await h.fire(h.accepted);
    await expect.poll(async () => (await f.store.recentFires(h.row)).length).toBe(1);
    expect((await f.store.recentFires(h.row))[0]).toMatchObject({ status: 'error', renderedPrompt: '  first line\n\nsecond line\n' });
    expect(diagnostic.messages).toHaveLength(1);
  });
});
// TASK-951: a check-in's brief counts a finish date's days from the day its run was accepted, on the task's own
// calendar: the accepted row is the snapshot the brief is built from, so its day is the one the count starts on.
describe("a check-in's accept time (TASK-951)", () => {
  it("a check-in's brief counts from the day it was accepted, in the task's time zone, not the clock when the brief is built (TASK-951)", async () => {
    const h = await setup({
      definition: { kind: 'get-done', goodWhen: 'Done when it is done.', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'America/Los_Angeles' } },
      finishBy: '2031-01-10',
    });
    await h.fire(h.accepted);
    // The fixture's `now`, 2031-01-01T00:00Z, is 16:00 on 31 December 2030 in Los Angeles. The wall clock is years
    // earlier, so a brief that counted from `new Date()` would say something else.
    expect(h.accepted.acceptedAt).toEqual(now);
    expect(h.pending.get(h.accepted.reqId)?.acceptedAt).toEqual(h.accepted.acceptedAt);
    const ctx = makeAgentContext({ reqId: h.accepted.reqId, sessionId: 's', agentId: 'a', userId: 'owner', conversationId: 'c', source: 'routine' });
    expect(checkInBrief(h.pending, ctx).brief).toContain('That’s 10 days from today (Tuesday, 31 December 2030).');
  });
});
describe('connector skips per fire (slice 6)', () => {
  function pendingEntry(over: Partial<PendingFire> = {}): PendingFire {
    return {
      row: sampleRow(), dispatchId: 'dispatch', conversationId: 'cnv', source: 'tick', renderedPrompt: 'p',
      agentName: 'Bob', skips: [], brief: 'waiting', acceptedAt: now, onTurnEnd: async () => { },
      ...over,
    };
  }
  it('an event for an unknown reqId is ignored', () => {
    const pending: PendingFires = new Map([['req-1', pendingEntry()]]);
    stashConnectorsSkipped(pending, {
      reqId: 'req-other',
      connectors: [{ connectorId: 'gmail', name: 'Gmail', reason: 'not-signed-in' }],
    });
    expect(pending.size).toBe(1);
    expect(pending.get('req-1')!.skips).toEqual([]);
    expect(pending.has('req-other')).toBe(false);
  });
  it('stashes valid skips, drops malformed entries, keeps an unknown reason as unavailable, and merges a repeat', () => {
    const pending: PendingFires = new Map([['req-1', pendingEntry()]]);
    stashConnectorsSkipped(pending, {
      reqId: 'req-1',
      connectors: [
        { connectorId: 'gmail', name: 'Gmail', reason: 'not-signed-in' },
        { connectorId: 'x', name: 'X', reason: 'exploded' },
        { connectorId: 7, name: 'Seven', reason: 'not-signed-in' },
        { connectorId: 'y', name: null, reason: 'not-signed-in' },
        null,
        'nope',
      ],
    });
    stashConnectorsSkipped(pending, {
      reqId: 'req-1',
      connectors: [
        { connectorId: 'gmail', name: 'Gmail', reason: 'not-signed-in' },
        { connectorId: 'linear', name: 'Linear', reason: 'needs-reconnect' },
      ],
    });
    expect(pending.get('req-1')!.skips).toEqual([
      { connectorId: 'gmail', name: 'Gmail', reason: 'not-signed-in' },
      { connectorId: 'x', name: 'X', reason: 'unavailable' },
      { connectorId: 'linear', name: 'Linear', reason: 'needs-reconnect' },
    ]);
  });
  // Final review — an unknown reason is worded generically, not dropped.
  it('an unknown reason is recorded as "wasn\'t available"', () => {
    const pending: PendingFires = new Map([['req-1', pendingEntry()]]);
    stashConnectorsSkipped(pending, {
      reqId: 'req-1',
      connectors: [{ connectorId: 'drive', name: 'Drive', reason: 'quota-exceeded' }],
    });
    expect(warningFor(pending.get('req-1')!)).toBe("Drive wasn't available on Bob, so this run went without it.");
  });
  // Final review — dropped entries for a REAL in-flight fire are logged
  // (counts only); an unknown reqId's payload is not.
  it('logs counts (never names) when a payload for an in-flight fire loses entries', () => {
    const pending: PendingFires = new Map([['req-1', pendingEntry()]]);
    const warns: Array<[
      string,
      Record<string, unknown>
    ]> = [];
    const logger = { warn: (msg: string, fields: Record<string, unknown>) => { warns.push([msg, fields]); } };
    stashConnectorsSkipped(pending, {
      reqId: 'req-1',
      connectors: [
        { connectorId: 'gmail', name: 'Gmail', reason: 'not-signed-in' },
        { connectorId: 7, name: 'Seven', reason: 'not-signed-in' },
        null,
      ],
    }, logger);
    expect(warns).toEqual([
      ['routines_connectors_skipped_entries_dropped', { received: 3, malformed: 2, overCap: 0 }],
    ]);
    expect(JSON.stringify(warns)).not.toMatch(/Seven|Gmail/);
    warns.length = 0;
    stashConnectorsSkipped(pending, { reqId: 'req-other', connectors: [null] }, logger);
    stashConnectorsSkipped(pending, {
      reqId: 'req-1', connectors: [{ connectorId: 'gmail', name: 'Gmail', reason: 'not-signed-in' }],
    }, logger); // a repeat is a merge, not a drop
    expect(warns).toEqual([]);
  });
  // Final review — contract: the producer's REAL payload (chat-orchestrator's
  // connectorsSkippedPayload) is accepted whole by this consumer.
  it('contract: connectorsSkippedPayload() output is stashed with every skip kept', () => {
    const pending: PendingFires = new Map([['req-c', pendingEntry()]]);
    const warns: unknown[] = [];
    const caps = { allowedHosts: [], credentials: [], mcpServers: [] };
    const payload = connectorsSkippedPayload('req-c', [
      { connector: { id: 'gmail', name: 'Gmail', capabilities: caps }, refs: ['account:gmail'], reason: 'not-signed-in' },
      { connector: { id: 'linear', name: 'Linear', capabilities: caps }, refs: [], reason: 'needs-reconnect' },
      { connector: { id: 'notion', capabilities: caps }, refs: ['account:notion'], reason: 'not-signed-in' },
    ]);
    stashConnectorsSkipped(pending, payload, { warn: (...a) => { warns.push(a); } });
    expect(warns).toEqual([]);
    expect(pending.get('req-c')!.skips).toEqual([
      { connectorId: 'gmail', name: 'Gmail', reason: 'not-signed-in' },
      { connectorId: 'linear', name: 'Linear', reason: 'needs-reconnect' },
      { connectorId: 'notion', name: 'notion', reason: 'not-signed-in' },
    ]);
    expect(warningFor(pending.get('req-c')!)).toBe("Gmail and notion aren't signed in on Bob, so this run went without them. "
      + 'Linear needs to be signed in again on Bob, so this run went without it.');
  });
  it('a payload that is not the expected shape is ignored without throwing', () => {
    const pending: PendingFires = new Map([['req-1', pendingEntry()]]);
    for (const bad of [undefined, null, 'x', { reqId: 'req-1' }, { reqId: 'req-1', connectors: 'x' }, { reqId: 5, connectors: [] }]) {
      expect(() => stashConnectorsSkipped(pending, bad)).not.toThrow();
    }
    expect(pending.get('req-1')!.skips).toEqual([]);
  });
  it('holds at most 50 skips per fire', () => {
    const pending: PendingFires = new Map([['req-1', pendingEntry()]]);
    stashConnectorsSkipped(pending, {
      reqId: 'req-1',
      connectors: Array.from({ length: 500 }, (_, i) => ({ connectorId: `c${i}`, name: `C${i}`, reason: 'not-signed-in' })),
    });
    expect(pending.get('req-1')!.skips).toHaveLength(50);
  });
  it('a nameless skip falls back to its connector id', () => {
    const pending: PendingFires = new Map([['req-1', pendingEntry()]]);
    stashConnectorsSkipped(pending, {
      reqId: 'req-1',
      connectors: [{ connectorId: 'gmail', name: ' ‮ ', reason: 'not-signed-in' }],
    });
    expect(warningFor(pending.get('req-1')!)).toBe("gmail isn't signed in on Bob, so this run went without it.");
  });
  it('warningFor: null when nothing was skipped', () => {
    expect(warningFor(pendingEntry())).toBeNull();
  });
});
