import { describe, expect, it, vi } from 'vitest';
import { HookBus, PluginError, type AgentContext } from '@ax/core';
// Contract test only (tests may cross packages; runtime code may not): the
// producer's real payload builder, fed into this plugin's consumer.
import { connectorsSkippedPayload } from '@ax/chat-orchestrator';
import {
  createFireRoutine, stashConnectorsSkipped, warningFor,
  type FireDeps, type PendingFire, type PendingFires,
} from '../fire.js';
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
    lastWarning: null, definitionId: null, definitionUpdatedAt: null,
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
  it('does not invoke a disabled routine, including manual fires', async () => {
    const invoke = vi.fn();
    const create = vi.fn();
    const bus = await makeBus({ invoke, create });
    const fire = createFireRoutine({ bus, pending: new Map() } as FireDeps);
    const result = await fire(row({ enabled: false }), 'manual');
    expect(result.status).toBe('error');
    expect(invoke).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

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

// Slice 6 — chat:connectors-skipped is keyed to the in-flight fire by reqId;
// whoever records the fire turns the stashed skips into its warning.
describe('connector skips per fire (slice 6)', () => {
  function pendingEntry(over: Partial<PendingFire> = {}): PendingFire {
    return {
      row: row(), conversationId: 'cnv', source: 'tick', renderedPrompt: 'p',
      agentName: 'Bob', skips: [], onTurnEnd: async () => {},
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
    expect(warningFor(pending.get('req-1')!)).toBe(
      "Drive wasn't available on Bob, so this run went without it.",
    );
  });

  // Final review — dropped entries for a REAL in-flight fire are logged
  // (counts only); an unknown reqId's payload is not.
  it('logs counts (never names) when a payload for an in-flight fire loses entries', () => {
    const pending: PendingFires = new Map([['req-1', pendingEntry()]]);
    const warns: Array<[string, Record<string, unknown>]> = [];
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
    expect(warningFor(pending.get('req-c')!)).toBe(
      "Gmail and notion aren't signed in on Bob, so this run went without them. "
      + 'Linear needs to be signed in again on Bob, so this run went without it.',
    );
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
    expect(warningFor(pending.get('req-1')!)).toBe(
      "gmail isn't signed in on Bob, so this run went without it.",
    );
  });

  it('warningFor: null when nothing was skipped', () => {
    expect(warningFor(pendingEntry())).toBeNull();
  });

  it('carries the agent display name from agents:resolve into the pending entry', async () => {
    const bus = await makeBus({
      resolve: async (agentId, userId) => ({ agent: { id: agentId, ownerId: userId, displayName: 'Bob' } }),
    });
    const pending: PendingFires = new Map();
    await createFireRoutine({ bus, pending } as FireDeps)(row(), 'tick');
    const [entry] = [...pending.values()];
    expect(entry!.agentName).toBe('Bob');
    expect(entry!.skips).toEqual([]);
  });

  it('an agent with no display name leaves agentName null ("this agent")', async () => {
    const bus = await makeBus({});
    const pending: PendingFires = new Map();
    await createFireRoutine({ bus, pending } as FireDeps)(row(), 'tick');
    const [entry] = [...pending.values()];
    expect(entry!.agentName).toBeNull();
    expect(warningFor({ ...entry!, skips: [{ connectorId: 'g', name: 'Gmail', reason: 'not-signed-in' }] }))
      .toBe("Gmail isn't signed in on this agent, so this run went without it.");
  });

  it('a terminated fire that skipped a connector records the warning on its row', async () => {
    const pending: PendingFires = new Map();
    const bus = await makeBus({
      resolve: async (agentId, userId) => ({ agent: { id: agentId, ownerId: userId, displayName: 'Bob' } }),
      invoke: async (ctx) => {
        stashConnectorsSkipped(pending, {
          reqId: ctx.reqId,
          connectors: [{ connectorId: 'gmail', name: 'Gmail', reason: 'needs-reconnect' }],
        });
        return { kind: 'terminated', reason: 'chat-timeout' };
      },
    });
    const recorded: RecordFireInput[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await createFireRoutine({ bus, pending, recordFire: async (i) => { recorded.push(i); } })(row(), 'tick');
      await vi.waitFor(() => expect(recorded).toHaveLength(1));
    } finally {
      stderr.mockRestore();
    }
    expect(recorded[0]).toMatchObject({
      status: 'error',
      warning: 'Gmail needs to be signed in again on Bob, so this run went without it.',
    });
  });

  it('a terminated fire with nothing skipped records warning: null (clears the last one)', async () => {
    const bus = await makeBus({ invoke: async () => ({ kind: 'terminated', reason: 'x' }) });
    const recorded: RecordFireInput[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await createFireRoutine({ bus, pending: new Map(), recordFire: async (i) => { recorded.push(i); } })(row(), 'tick');
      await vi.waitFor(() => expect(recorded).toHaveLength(1));
    } finally {
      stderr.mockRestore();
    }
    expect(recorded[0]!.warning).toBeNull();
  });

  it('two concurrent fires each get their own warning, keyed by reqId', async () => {
    const pending: PendingFires = new Map();
    const release: Array<() => void> = [];
    const bus = await makeBus({
      resolve: async (agentId, userId) => ({ agent: { id: agentId, ownerId: userId, displayName: 'Bob' } }),
      invoke: async (ctx) => {
        const name = ctx.triggerLabel === 'one' ? 'Gmail' : 'Linear';
        stashConnectorsSkipped(pending, {
          reqId: ctx.reqId,
          connectors: [{ connectorId: name.toLowerCase(), name, reason: 'not-signed-in' }],
        });
        await new Promise<void>((r) => release.push(r));
        return { kind: 'terminated', reason: 'x' };
      },
    });
    const recorded: RecordFireInput[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const fire = createFireRoutine({ bus, pending, recordFire: async (i) => { recorded.push(i); } });
      await fire(row({ name: 'one', path: 'one.md' }), 'tick');
      await fire(row({ name: 'two', path: 'two.md' }), 'tick');
      await vi.waitFor(() => expect(release).toHaveLength(2));
      for (const r of release) r();
      await vi.waitFor(() => expect(recorded).toHaveLength(2));
    } finally {
      stderr.mockRestore();
    }
    const byPath = Object.fromEntries(recorded.map((r) => [r.path, r.warning]));
    expect(byPath).toEqual({
      'one.md': "Gmail isn't signed in on Bob, so this run went without it.",
      'two.md': "Linear isn't signed in on Bob, so this run went without it.",
    });
  });
});

// Final review ruling — a fire that fails BEFORE turn assembly leaves the
// routine's last_warning unchanged (`warning` omitted); one that may have
// reached assembly writes it (a sentence or null).
describe('which settled fires touch last_warning (slice 6)', () => {
  async function settle(invoke: (ctx: AgentContext) => Promise<unknown>): Promise<RecordFireInput> {
    const bus = await makeBus({ invoke });
    const recorded: RecordFireInput[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await createFireRoutine({
        bus, pending: new Map(), recordFire: async (i) => { recorded.push(i); }, turnEndGraceMs: 5,
      })(row(), 'tick');
      await vi.waitFor(() => expect(recorded).toHaveLength(1));
    } finally {
      stderr.mockRestore();
    }
    return recorded[0]!;
  }

  it('a chat:start veto → warning omitted', async () => {
    const r = await settle(async () => ({ kind: 'terminated', reason: 'chat:start:quota' }));
    expect(r.status).toBe('error');
    expect('warning' in r).toBe(false);
  });

  it('an agents:resolve refusal inside the invoke → warning omitted', async () => {
    const r = await settle(async () => ({ kind: 'terminated', reason: 'agent-resolve:forbidden' }));
    expect('warning' in r).toBe(false);
  });

  it('a dispatch error (the invoke threw) → warning omitted', async () => {
    const r = await settle(async () => { throw new Error('no agent:invoke'); });
    expect(r.status).toBe('error');
    expect('warning' in r).toBe(false);
  });

  // Residual review — skips stashed for this fire prove it reached assembly,
  // whatever the outcome says afterwards.
  it('a fire that stashed skips and then threw (or was refused) still records its warning', async () => {
    for (const end of [
      async () => { throw new Error('transport blip'); },
      async () => ({ kind: 'terminated', reason: 'agent-resolve:internal' }),
    ]) {
      const pending: PendingFires = new Map();
      const bus = await makeBus({
        resolve: async (agentId, userId) => ({ agent: { id: agentId, ownerId: userId, displayName: 'Bob' } }),
        invoke: async (ctx) => {
          stashConnectorsSkipped(pending, {
            reqId: ctx.reqId,
            connectors: [{ connectorId: 'gmail', name: 'Gmail', reason: 'not-signed-in' }],
          });
          return end();
        },
      });
      const recorded: RecordFireInput[] = [];
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await createFireRoutine({ bus, pending, recordFire: async (i) => { recorded.push(i); } })(row(), 'tick');
        await vi.waitFor(() => expect(recorded).toHaveLength(1));
      } finally {
        stderr.mockRestore();
      }
      expect(recorded[0]!.warning).toBe("Gmail isn't signed in on Bob, so this run went without it.");
    }
  });

  it('any other terminated run → warning written (null when nothing was skipped)', async () => {
    const r = await settle(async () => ({ kind: 'terminated', reason: 'connector-needs-reconnect' }));
    expect(r.warning).toBeNull();
  });

  it('complete without a turn end (grace backstop) → warning written', async () => {
    const r = await settle(async () => ({ kind: 'complete', messages: [] }));
    expect(r.warning).toBeNull();
  });
});
