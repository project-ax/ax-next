import { describe, it, expect } from 'vitest';
import {
  HookBus,
  PluginError,
  makeChatContext,
  createLogger,
  type ToolCall,
} from '@ax/core';
import { createToolDispatcherPlugin } from '../plugin.js';

const ctx = () =>
  makeChatContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
  });

describe('tool-dispatcher', () => {
  it('registers tool:execute', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    expect(bus.hasService('tool:execute')).toBe(true);
  });

  it('returns the sub-service result and forwards ctx + input', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    let seen: unknown;
    bus.registerService<unknown, unknown>('tool:execute:echo', 'test', async (_c, i) => {
      seen = i;
      return { seen: i };
    });
    const call: ToolCall = { id: 't1', name: 'echo', input: { x: 1 } };
    const r = await bus.call<ToolCall, unknown>('tool:execute', ctx(), call);
    expect(r).toEqual({ seen: { x: 1 } });
    expect(seen).toEqual({ x: 1 });
  });

  it('throws no-service with the sub-hook name when sub is missing', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    const err = await bus
      .call<ToolCall, unknown>('tool:execute', ctx(), { id: 't1', name: 'mystery', input: {} })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('no-service');
    expect(err.hookName).toBe('tool:execute:mystery');
  });

  it('rejects tool name "../escape" with invalid-payload', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    const err = await bus
      .call<ToolCall, unknown>('tool:execute', ctx(), { id: 't1', name: '../escape', input: {} })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
  });

  it('rejects uppercase tool name "UPPER"', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    const err = await bus
      .call<ToolCall, unknown>('tool:execute', ctx(), { id: 't1', name: 'UPPER', input: {} })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
  });

  it('rejects empty tool name', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    const err = await bus
      .call<ToolCall, unknown>('tool:execute', ctx(), { id: 't1', name: '', input: {} })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
  });

  it('rejects a name longer than 32 chars', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    const err = await bus
      .call<ToolCall, unknown>('tool:execute', ctx(), {
        id: 't1',
        name: 'a'.repeat(33),
        input: {},
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
  });

  it('accepts name "bash"', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    bus.registerService('tool:execute:bash', 'test', async () => ({ ok: true }));
    await expect(
      bus.call<ToolCall, unknown>('tool:execute', ctx(), { id: 't1', name: 'bash', input: {} }),
    ).resolves.toEqual({ ok: true });
  });

  it('accepts name "read_file" (underscore allowed)', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    bus.registerService('tool:execute:read_file', 'test', async () => ({ ok: true }));
    await expect(
      bus.call<ToolCall, unknown>('tool:execute', ctx(), {
        id: 't1',
        name: 'read_file',
        input: {},
      }),
    ).resolves.toEqual({ ok: true });
  });
});
