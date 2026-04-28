import { describe, it, expect } from 'vitest';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  createLogger,
  type ToolDescriptor,
} from '@ax/core';
import { createToolDispatcherPlugin } from '@ax/tool-dispatcher';
import { createTestHostToolPlugin } from '../test-host-tool.js';

const ctx = () =>
  makeAgentContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
  });

async function bootBus(): Promise<HookBus> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [createToolDispatcherPlugin(), createTestHostToolPlugin()],
    config: {},
  });
  return bus;
}

describe('test-host-echo stub plugin', () => {
  it('manifest declares the expected registers/calls/subscribes', () => {
    const plugin = createTestHostToolPlugin();
    expect(plugin.manifest.registers).toEqual(['tool:execute:test-host-echo']);
    expect(plugin.manifest.calls).toEqual(['tool:register']);
    expect(plugin.manifest.subscribes).toEqual([]);
  });

  it('registers a host-executing descriptor visible via tool:list', async () => {
    const bus = await bootBus();
    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    const echo = list.tools.find((t) => t.name === 'test-host-echo');
    expect(echo).toBeDefined();
    expect(echo?.executesIn).toBe('host');
    expect(echo?.description).toMatch(/echo/i);
    expect(echo?.inputSchema).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
  });

  it('tool:execute:test-host-echo returns { output: text }', async () => {
    const bus = await bootBus();
    const res = await bus.call<{ text: string }, { output: string }>(
      'tool:execute:test-host-echo',
      ctx(),
      { text: 'hello' },
    );
    expect(res).toEqual({ output: 'hello' });
  });

  it('accepts empty string', async () => {
    const bus = await bootBus();
    const res = await bus.call<{ text: string }, { output: string }>(
      'tool:execute:test-host-echo',
      ctx(),
      { text: '' },
    );
    expect(res).toEqual({ output: '' });
  });

  it('missing text field → PluginError with code invalid-payload', async () => {
    const bus = await bootBus();
    const err = await bus
      .call('tool:execute:test-host-echo', ctx(), {} as unknown as { text: string })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
    expect(err.hookName).toBe('tool:execute:test-host-echo');
  });

  it('wrong-type text field → PluginError with code invalid-payload', async () => {
    const bus = await bootBus();
    const err = await bus
      .call(
        'tool:execute:test-host-echo',
        ctx(),
        { text: 42 } as unknown as { text: string },
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
  });

  // Regression: the IPC dispatcher for `tool.execute-host` invokes this
  // service hook with the whole `ToolCall` envelope (`{id, name, input}`),
  // not the bare input object. The Task-13 stub originally parsed the raw
  // argument and failed in production with `text: undefined`. It now
  // unwraps `.input` when present. Caught by Week 6.5d Task 14 e2e.
  it('accepts the full ToolCall envelope from tool.execute-host', async () => {
    const bus = await bootBus();
    const res = await bus.call<
      { id: string; name: string; input: { text: string } },
      { output: string }
    >(
      'tool:execute:test-host-echo',
      ctx(),
      { id: 'call-1', name: 'test-host-echo', input: { text: 'wrapped' } },
    );
    expect(res).toEqual({ output: 'wrapped' });
  });
});
