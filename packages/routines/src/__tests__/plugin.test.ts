import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import { sql } from 'kysely';
import { HookBus, makeAgentContext, MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS } from '@ax/core';
import { createRoutinesPlugin } from '../plugin.js';
import { CAPTURE_CHECK_DEADLINE_MS } from '../capture.js';
import { createRoutinesStore } from '../store.js';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { logged } from './support/report-log.js';
import { failQueries } from './support/fail-query.js';
let h: RoutineHarness;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); });
const definition = RoutineDefinitionSchema.parse({ name: 'Check', promptBody: 'Check', silenceToken: 'QUIET', trigger: { kind: 'interval', every: '1h' } });
async function create() { return h.bus.call<unknown, RoutineView>('routines:create', h.owner, { agentId: h.agentId, requestId: 'create', definition }); }
const fireInput = (r: RoutineView) => ({ agentId: r.agentId, routineId: r.routineId, expectedRevision: r.revision, requestId: 'fire' });
describe('routines runtime registration', () => {
  it('declares all runtime dependencies and subscriptions without file sync or token rebind', () => {
    const { manifest } = createRoutinesPlugin();
    expect(manifest.registers).toContain('routines:fire-now');
    expect(manifest.calls).toContain('agents:resolve-by-webhook-token');
    expect(manifest.registers).toContain('system-prompt:augment:optional:routines');
    expect(manifest.subscribes).toEqual(expect.arrayContaining(['agents:deleted', 'chat:turn-end', 'chat:connectors-skipped', 'chat:system-prompt-landed', 'memory:pre-capture']));
    expect(manifest.subscribes).not.toContain('workspace:applied');
    expect(manifest.subscribes).not.toContain('agents:webhook-token-rotated');
  });
  it.each([true, false])('finishes once with silence, warning and turn-id safety (turnId=%s)', async (hasTurnId) => {
    const warnings: string[] = [];
    h = await createRoutineHarness({ invoke: async (ctx, bus) => {
        const warn = ctx.logger.warn.bind(ctx.logger);
        ctx.logger.warn = (message, fields) => {
          if (!hasTurnId && message === 'routines_drop_turn_skipped_no_turn_id') warnings.push(message);
          else warn(message, fields);
        };
        await bus.fire('chat:connectors-skipped', ctx, { reqId: ctx.reqId, connectors: [{ connectorId: 'gmail', name: 'Gmail', reason: 'not-signed-in' }] });
        const result = { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'QUIET' }], ...(hasTurnId ? { turnId: 'turn' } : {}) };
        await bus.fire('chat:turn-end', ctx, result);
        await bus.fire('chat:turn-end', ctx, result);
        return { kind: 'terminated', reason: 'late' };
      } });
    const row = await create();
    const calls = vi.spyOn(h.bus, 'call');
    await h.bus.call('routines:fire-now', h.owner, fireInput(row));
    const store = createRoutinesStore(h.db);
    await expect.poll(async () => (await store.recentFires(row)).length).toBe(1);
    expect((await store.recentFires(row))[0]).toMatchObject({ status: 'silenced', warning: expect.stringContaining('Gmail') });
    expect(calls.mock.calls.filter(([hook]) => hook === 'conversations:drop-turn')).toHaveLength(hasTurnId ? 1 : 0);
    expect(calls.mock.calls.filter(([hook]) => hook === 'conversations:hide')).toHaveLength(1);
    expect((await store.findOne(row))?.lastStatus).toBe('silenced');
    expect(warnings).toHaveLength(hasTurnId ? 0 : 1);
  });
  it('does not recreate dispatch/history/status after deletion during a deferred invoke', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let ended!: () => void;
    const done = new Promise<void>(r => { ended = r; });
    h = await createRoutineHarness({ invoke: async (ctx, bus) => { await gate; await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] }); ended(); return { kind: 'complete' }; } });
    const row = await create();
    await h.bus.call('routines:fire-now', h.owner, fireInput(row));
    expect(h.invokeCalls).toHaveLength(1);
    await h.bus.call('agents:delete', h.owner, { agentId: h.agentId, actor: { userId: h.owner.userId, isAdmin: false } });
    release();
    await done;
    const store = createRoutinesStore(h.db);
    expect(await store.findOne(row)).toBeNull();
    expect(await store.recentFires({ agentId: row.agentId, routineId: row.routineId, actorUserId: h.owner.userId })).toEqual([]);
    expect((await sql `SELECT * FROM routines_v1_dispatches WHERE agent_id=${h.agentId}`.execute(h.db)).rows).toEqual([]);
  });
  it('restarts by interrupting abandoned acceptance without invoking it again', async () => {
    h = await createRoutineHarness();
    const row = await create();
    const store = createRoutinesStore(h.db);
    await store.acceptDispatch({ ...fireInput(row), actorUserId: h.owner.userId, source: 'manual', now: new Date() });
    h = await h.restart();
    expect(h.invokeCalls).toEqual([]);
    expect((await createRoutinesStore(h.db).recentFires(row))[0]).toMatchObject({ status: 'error', error: expect.stringContaining('interrupted') });
  });
  it('concurrent manual retries invoke the real runtime once and retain one completed result', async () => {
    h = await createRoutineHarness({ invoke: async (ctx, bus) => { await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] }); return { kind: 'complete' }; } });
    const row = await create();
    const input = fireInput(row);
    expect(await Promise.all([h.bus.call('routines:fire-now', h.owner, input), h.bus.call('routines:fire-now', h.owner, input)])).toEqual([{ status: 'ok' }, { status: 'ok' }]);
    expect(h.invokeCalls).toHaveLength(1);
    await expect.poll(async () => (await createRoutinesStore(h.db).recentFires(row)).length).toBe(1);
  });
});

// TASK-908: memory may ask about a conversation while routines is still starting (a runner
// reporting into a freshly restarted host). The capture veto is subscribed before the database
// is ready, and a lookup that can't run in time refuses rather than letting the pass through.
describe('the capture veto while routines starts (TASK-908)', () => {
  it('a capture pass during a start that never finishes is refused at the deadline, not skipped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const bus = new HookBus();
      bus.registerService('database:get-instance', 'test', () => new Promise(() => {}));
      void createRoutinesPlugin().init({ bus } as Parameters<ReturnType<typeof createRoutinesPlugin>['init']>[0]);
      await Promise.resolve();
      const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent', userId: 'owner', conversationId: 'c-task', source: 'routine' });
      const asked = bus.fire('memory:pre-capture', ctx, { conversationId: 'c-task' }, { subscriberTimeoutMs: MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS });
      await vi.advanceTimersByTimeAsync(CAPTURE_CHECK_DEADLINE_MS);
      expect(await asked).toMatchObject({ rejected: true, source: '@ax/routines', reason: 'task-check-in' });
    } finally { vi.useRealTimers(); }
  });
});

// TASK-1058: a subscriber's failure line carries the ids and the error's codes, never its message.
const PRIVATE = () => Object.assign(new Error('PRIVATE pg text at 10.0.0.7'), { code: '57P01' });
/** The one `msg` line: these ids, the injected error's codes, nothing else, and no message text anywhere. */
function expectOneCodeOnly(lines: readonly string[], msg: string, ids: Record<string, unknown>): void {
  const entries = lines.map(l => JSON.parse(l) as Record<string, unknown>).filter(e => e.msg === msg);
  expect(entries).toEqual([{ level: 'warn', ts: expect.any(String), reqId: expect.any(String), msg, ...ids, code: '57P01', name: 'Error' }]);
  expect(lines.join('\n')).not.toMatch(/PRIVATE|10\.0\.0\.7/);
}
describe('failure lines carry codes only (TASK-1058)', () => {
  it('a purge that fails for a deleted agent', async () => {
    h = await createRoutineHarness();
    const { ctx, lines } = logged(h.owner);
    const restore = failQueries(/insert into "routines_v1_retired_agents"/, PRIVATE());
    try { await h.bus.fire('agents:deleted', ctx, { agentId: h.agentId }); } finally { restore(); }
    expectOneCodeOnly(lines, 'routines_remove_for_deleted_agent_failed', { agentId: h.agentId });
  });

  it('a connectors-skipped payload that throws when read', async () => {
    h = await createRoutineHarness();
    const { ctx, lines } = logged(h.owner);
    await h.bus.fire('chat:connectors-skipped', ctx, { get reqId(): string { throw PRIVATE(); }, connectors: [] });
    expectOneCodeOnly(lines, 'routines_connectors_skipped_failed', {});
  });

  it('drop-turn and hide failures on a silenced turn', async () => {
    const lines: string[] = [];
    h = await createRoutineHarness({ invoke: async (ctx, bus) => {
      const l = logged(ctx);
      await bus.fire('chat:turn-end', l.ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'QUIET' }], turnId: 'turn' });
      lines.push(...l.lines);
      return { kind: 'complete' };
    } });
    const row = await create();
    const callThrough = h.bus.call.bind(h.bus);
    vi.spyOn(h.bus, 'call').mockImplementation(async (hook: string, ctx: Parameters<typeof callThrough>[1], input: unknown) => {
      if (hook === 'conversations:drop-turn' || hook === 'conversations:hide') throw PRIVATE();
      return callThrough(hook, ctx, input);
    });
    await h.bus.call('routines:fire-now', h.owner, fireInput(row));
    const store = createRoutinesStore(h.db);
    const asOwner = { ...row, actorUserId: h.owner.userId };
    await expect.poll(async () => (await store.recentFires(asOwner)).length).toBe(1);
    expect((await store.recentFires(asOwner))[0]).toMatchObject({ status: 'silenced' });
    expectOneCodeOnly(lines, 'routines_drop_turn_failed', { conversationId: expect.any(String) });
    expectOneCodeOnly(lines, 'routines_hide_failed', { conversationId: expect.any(String) });
  });

  it("a turn-end whose run can't be recorded", async () => {
    const lines: string[] = [];
    let ended!: () => void;
    const done = new Promise<void>(r => { ended = r; });
    h = await createRoutineHarness({ invoke: async (ctx, bus) => {
      const l = logged(ctx);
      const restore = failQueries(/insert into "routines_v1_fires"/, PRIVATE());
      try { await bus.fire('chat:turn-end', l.ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] }); } finally { restore(); }
      lines.push(...l.lines);
      ended();
      return { kind: 'complete' };
    } });
    const row = await create();
    await h.bus.call('routines:fire-now', h.owner, fireInput(row));
    await done;
    expectOneCodeOnly(lines, 'routines_turn_end_handler_failed', {});
  });
});
