import { describe, expect, it, vi } from 'vitest';
import { HookBus, PluginError, type AgentContext } from '@ax/core';
import { createFireRoutine, type FireDeps, type PendingFires } from '../fire.js';
import type { RoutineRow } from '../types.js';
import type { RecordFireInput } from '../store.js';

function row(over: Partial<RoutineRow> = {}): RoutineRow {
  return {
    agentId: 'agt_a', path: '.ax/routines/r.md', ownerUserId: 'u1',
    name: 'r', description: 'd', specHash: 'h',
    trigger: { kind: 'interval', every: '60s' },
    activeHours: null, silenceToken: null, silenceMaxChars: 300,
    conversation: 'per-fire', promptBody: 'do work',
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null,
    ...over,
  };
}

async function makeBus(opts: {
  resolve?: (agentId: string, userId: string) => Promise<{ agent: unknown }>;
  invoke?: (ctx: AgentContext, input: unknown) => Promise<unknown>;
  findOrCreate?: (input: unknown) => Promise<unknown>;
  create?: (input: unknown) => Promise<unknown>;
}) {
  const bus = new HookBus();
  bus.registerService('agents:resolve', 'test', async (_ctx, input) => {
    const i = input as { agentId: string; userId: string };
    return opts.resolve
      ? await opts.resolve(i.agentId, i.userId)
      : { agent: { id: i.agentId, ownerId: i.userId, workspaceRef: null } };
  });
  bus.registerService('agent:invoke', 'test', async (ctx, input) => {
    return opts.invoke
      ? await opts.invoke(ctx, input)
      : { kind: 'complete', messages: [] };
  });
  bus.registerService('conversations:find-or-create', 'test', async (_ctx, input) => {
    return opts.findOrCreate
      ? await opts.findOrCreate(input)
      : { conversation: { conversationId: 'cnv_shared', userId: 'u1', agentId: 'agt_a' }, created: true };
  });
  bus.registerService('conversations:create', 'test', async (_ctx, input) => {
    return opts.create
      ? await opts.create(input)
      : { conversationId: 'cnv_perfire', userId: 'u1', agentId: 'agt_a' };
  });
  return bus;
}

describe('fireRoutine', () => {
  it('per-fire: calls conversations:create and agent:invoke with the prompt body', async () => {
    let createdWith: unknown;
    let invokedWith: unknown;
    const bus = await makeBus({
      create: async (input) => { createdWith = input; return { conversationId: 'cnv_x', userId: 'u1', agentId: 'agt_a' }; },
      invoke: async (_ctx, input) => { invokedWith = input; return { kind: 'complete', messages: [] }; },
    });
    const pending: PendingFires = new Map();
    const fire = createFireRoutine({ bus, pending } as FireDeps);
    const result = await fire(row(), 'tick');
    expect((createdWith as { agentId: string }).agentId).toBe('agt_a');
    expect((invokedWith as { message: { content: string } }).message.content).toBe('do work');
    expect(result.conversationId).toBe('cnv_x');
    expect(pending.size).toBe(1);
  });

  it('shared: calls conversations:find-or-create with externalKey = row.path', async () => {
    let foundOrCreatedWith: unknown;
    const bus = await makeBus({
      findOrCreate: async (input) => {
        foundOrCreatedWith = input;
        return { conversation: { conversationId: 'cnv_s', userId: 'u1', agentId: 'agt_a' }, created: false };
      },
    });
    const pending: PendingFires = new Map();
    const fire = createFireRoutine({ bus, pending } as FireDeps);
    await fire(row({ conversation: 'shared' }), 'tick');
    expect((foundOrCreatedWith as { externalKey: string }).externalKey).toBe('.ax/routines/r.md');
  });

  it('reports agentGone when agents:resolve says the agent does not exist (TASK-680)', async () => {
    const bus = await makeBus({
      resolve: async (agentId) => { throw new PluginError({ code: 'not-found', plugin: '@ax/agents', hookName: 'agents:resolve', message: `agent '${agentId}' not found` }); },
    });
    const fire = createFireRoutine({ bus, pending: new Map() } as FireDeps);
    const result = await fire(row(), 'tick');
    expect(result.status).toBe('error');
    expect(result.agentGone).toBe(true);
  });

  it('does not report agentGone for a forbidden resolve — the agent still exists (TASK-680)', async () => {
    const bus = await makeBus({
      resolve: async () => { throw new PluginError({ code: 'forbidden', plugin: '@ax/agents', hookName: 'agents:resolve', message: 'denied' }); },
    });
    const fire = createFireRoutine({ bus, pending: new Map() } as FireDeps);
    const result = await fire(row(), 'tick');
    expect(result.agentGone).not.toBe(true);
  });

  it('does not report agentGone for a not-found raised by a different hook and propagated through resolve (TASK-680)', async () => {
    const bus = await makeBus({
      resolve: async () => { throw new PluginError({ code: 'not-found', plugin: '@ax/teams', hookName: 'teams:is-member', message: "team 't1' not found" }); },
    });
    const fire = createFireRoutine({ bus, pending: new Map() } as FireDeps);
    const result = await fire(row(), 'tick');
    expect(result.status).toBe('error');
    expect(result.agentGone).not.toBe(true);
  });

  it('propagates an agents:resolve forbidden as error status', async () => {
    const bus = await makeBus({
      resolve: async () => { throw new PluginError({ code: 'forbidden', plugin: 'agents', hookName: 'agents:resolve', message: 'denied' }); },
    });
    const pending: PendingFires = new Map();
    const fire = createFireRoutine({ bus, pending } as FireDeps);
    const result = await fire(row(), 'tick');
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/forbidden|denied/i);
    expect(pending.size).toBe(0);
  });

  it('stamps source: "routine" on the fire ctx passed to agent:invoke', async () => {
    let invokedCtx: AgentContext | undefined;
    const bus = await makeBus({
      invoke: async (ctx) => { invokedCtx = ctx; return { kind: 'complete', messages: [] }; },
    });
    const fire = createFireRoutine({ bus, pending: new Map() });
    await fire(row(), 'tick');
    // agent:invoke is fire-and-forget; let the microtask run.
    await new Promise((r) => setImmediate(r));
    expect(invokedCtx).toBeDefined();
    expect(invokedCtx!.source).toBe('routine');
  });

  it('stamps triggerLabel with the routine name on the fire ctx passed to agent:invoke', async () => {
    let invokedCtx: AgentContext | undefined;
    const bus = await makeBus({
      invoke: async (ctx) => { invokedCtx = ctx; return { kind: 'complete', messages: [] }; },
    });
    const fire = createFireRoutine({ bus, pending: new Map() });
    await fire(row({ name: 'Morning email pass' }), 'tick');
    // agent:invoke is fire-and-forget; let the microtask run.
    await new Promise((r) => setImmediate(r));
    expect(invokedCtx).toBeDefined();
    expect(invokedCtx!.triggerLabel).toBe('Morning email pass');
  });

  it('agent:invoke is fire-and-forget — does not block on completion', async () => {
    let resolveInvoke!: () => void;
    const invokePromise = new Promise<unknown>((res) => { resolveInvoke = () => res({ kind: 'complete', messages: [] }); });
    const bus = await makeBus({
      invoke: async () => invokePromise,
    });
    const pending: PendingFires = new Map();
    const fire = createFireRoutine({ bus, pending } as FireDeps);
    const t0 = Date.now();
    const result = await Promise.race([
      fire(row(), 'tick'),
      new Promise<{ blocked: true }>((res) => setTimeout(() => res({ blocked: true } as never), 200)),
    ]);
    expect((result as { blocked?: true }).blocked).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(200);
    resolveInvoke();
    await invokePromise;
  });
});

describe('createFireRoutine — webhook payload templating (Phase C)', () => {
  it('substitutes {{payload.x}} into the agent:invoke content when source=webhook', async () => {
    const captured: Array<{ content: string }> = [];
    const bus = await makeBus({
      invoke: async (_ctx, input) => {
        captured.push((input as { message: { content: string } }).message);
        return { kind: 'complete', messages: [] };
      },
    });
    const fire = createFireRoutine({ bus, pending: new Map() });
    const r = row({
      trigger: { kind: 'webhook', path: '/r' },
      promptBody: 'PR {{payload.pr.title}}',
    });
    await fire(r, 'webhook', { pr: { title: 'fix bug' } });
    await new Promise(r => setImmediate(r));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.content).toBe('PR fix bug');
  });

  it('passes promptBody verbatim when source=tick (no templating)', async () => {
    const captured: Array<{ content: string }> = [];
    const bus = await makeBus({
      invoke: async (_ctx, input) => {
        captured.push((input as { message: { content: string } }).message);
        return { kind: 'complete', messages: [] };
      },
    });
    const fire = createFireRoutine({ bus, pending: new Map() });
    const r = row({ promptBody: 'literal {{payload.x}}' });
    await fire(r, 'tick');
    await new Promise(r => setImmediate(r));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.content).toBe('literal {{payload.x}}');
  });

  it('passes promptBody verbatim when source=webhook but payload is undefined', async () => {
    const captured: Array<{ content: string }> = [];
    const bus = await makeBus({
      invoke: async (_ctx, input) => {
        captured.push((input as { message: { content: string } }).message);
        return { kind: 'complete', messages: [] };
      },
    });
    const fire = createFireRoutine({ bus, pending: new Map() });
    const r = row({
      trigger: { kind: 'webhook', path: '/r' },
      promptBody: 'no payload {{payload.x}}',
    });
    await fire(r, 'webhook'); // 3rd arg omitted
    await new Promise(r => setImmediate(r));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.content).toBe('no payload {{payload.x}}');
  });

  it('templating handles missing field by substituting empty string', async () => {
    const captured: Array<{ content: string }> = [];
    const bus = await makeBus({
      invoke: async (_ctx, input) => {
        captured.push((input as { message: { content: string } }).message);
        return { kind: 'complete', messages: [] };
      },
    });
    const fire = createFireRoutine({ bus, pending: new Map() });
    const r = row({
      trigger: { kind: 'webhook', path: '/r' },
      promptBody: 'event=[{{payload.missing}}]',
    });
    await fire(r, 'webhook', { other: 'value' });
    await new Promise(r => setImmediate(r));
    expect(captured[0]!.content).toBe('event=[]');
  });

  // TASK-679: a dispatched fire's ONE row is written by whoever takes its
  // pending entry. On the ordinary path that is the chat:turn-end subscriber;
  // when the invoke fails before any turn ends, it is fire.ts, as an error.
  describe('one row per fire when the invoke settles without a turn (TASK-679)', () => {
    it('reports the fire as dispatched — the caller must not write a row of its own', async () => {
      const bus = await makeBus({});
      const recorded: RecordFireInput[] = [];
      const fire = createFireRoutine({
        bus, pending: new Map(), recordFire: async (i) => { recorded.push(i); },
      });
      const result = await fire(row(), 'tick');
      expect(result).toMatchObject({ status: 'ok', recordedAtTurnEnd: true });
    });

    it('a rejected invoke records exactly one error row and drops the pending entry', async () => {
      const bus = await makeBus({ invoke: async () => { throw new Error('sandbox died'); } });
      const pending: PendingFires = new Map();
      const recorded: RecordFireInput[] = [];
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const fire = createFireRoutine({ bus, pending, recordFire: async (i) => { recorded.push(i); } });
        await fire(row(), 'manual');
        await vi.waitFor(() => expect(recorded).toHaveLength(1));
      } finally {
        stderr.mockRestore();
      }
      expect(recorded[0]).toMatchObject({
        agentId: 'agt_a', path: '.ax/routines/r.md', triggerSource: 'manual',
        conversationId: 'cnv_perfire', status: 'error', renderedPrompt: 'do work',
      });
      expect(recorded[0]!.error).toContain('sandbox died');
      expect(pending.size).toBe(0);
    });

    it('a terminated outcome with no turn end records exactly one error row', async () => {
      const bus = await makeBus({ invoke: async () => ({ kind: 'terminated', reason: 'chat-timeout' }) });
      const pending: PendingFires = new Map();
      const recorded: RecordFireInput[] = [];
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const fire = createFireRoutine({ bus, pending, recordFire: async (i) => { recorded.push(i); } });
        await fire(row(), 'tick');
        await vi.waitFor(() => expect(recorded).toHaveLength(1));
      } finally {
        stderr.mockRestore();
      }
      expect(recorded[0]).toMatchObject({ status: 'error', triggerSource: 'tick' });
      expect(recorded[0]!.error).toContain('chat-timeout');
      expect(pending.size).toBe(0);
    });

    it('records NOTHING when the turn end already took the pending entry', async () => {
      const pending: PendingFires = new Map();
      const bus = await makeBus({
        invoke: async (ctx) => {
          // Stands in for the chat:turn-end subscriber, which removes the
          // entry and writes the fire's row before the invoke settles.
          pending.delete(ctx.reqId);
          return { kind: 'terminated', reason: 'cancelled after turn' };
        },
      });
      const recorded: RecordFireInput[] = [];
      const fire = createFireRoutine({ bus, pending, recordFire: async (i) => { recorded.push(i); } });
      await fire(row(), 'tick');
      // Let the invoke's settle handlers run.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(recorded).toEqual([]);
    });

    it('a complete outcome with no turn end records one error row once the grace runs out', async () => {
      const pending: PendingFires = new Map();
      const bus = await makeBus({});
      const recorded: RecordFireInput[] = [];
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const fire = createFireRoutine({
          bus, pending, recordFire: async (i) => { recorded.push(i); }, turnEndGraceMs: 0,
        });
        await fire(row(), 'tick');
        await vi.waitFor(() => expect(recorded).toHaveLength(1));
      } finally {
        stderr.mockRestore();
      }
      expect(recorded[0]).toMatchObject({ status: 'error', triggerSource: 'tick' });
      expect(pending.size).toBe(0);
    });

    it('a complete outcome leaves the row to the turn end', async () => {
      const pending: PendingFires = new Map();
      const bus = await makeBus({});
      const recorded: RecordFireInput[] = [];
      const fire = createFireRoutine({
        bus, pending, recordFire: async (i) => { recorded.push(i); }, turnEndGraceMs: 60_000,
      });
      await fire(row(), 'tick');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(recorded).toEqual([]);
      expect(pending.size).toBe(1);
    });
  });
});
