import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import { createFireRoutine, type FireDeps, type PendingFires } from '../fire.js';
import type { RoutineRow } from '../types.js';

function row(over: Partial<RoutineRow> = {}): RoutineRow {
  return {
    agentId: 'agt_a', path: '.ax/routines/r.md', authorUserId: 'u1',
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
