import { describe, it, expect } from 'vitest';
import {
  HookBus,
  PluginError,
  makeChatContext,
  createLogger,
  type ToolDescriptor,
} from '@ax/core';
import { createToolDispatcherPlugin } from '../plugin.js';

const ctx = () =>
  makeChatContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
  });

async function makeBus(): Promise<HookBus> {
  const bus = new HookBus();
  await createToolDispatcherPlugin().init({ bus, config: {} });
  return bus;
}

const sampleDescriptor = (overrides: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  name: 'bash',
  description: 'run a command',
  inputSchema: { type: 'object' },
  executesIn: 'sandbox',
  ...overrides,
});

describe('tool-dispatcher', () => {
  it('registers tool:register and tool:list', async () => {
    const bus = await makeBus();
    expect(bus.hasService('tool:register')).toBe(true);
    expect(bus.hasService('tool:list')).toBe(true);
    // The old umbrella is gone.
    expect(bus.hasService('tool:execute')).toBe(false);
  });

  it('tool:register returns { ok: true } and tool:list surfaces the descriptor', async () => {
    const bus = await makeBus();
    const desc = sampleDescriptor();
    const ack = await bus.call<ToolDescriptor, { ok: true }>('tool:register', ctx(), desc);
    expect(ack).toEqual({ ok: true });
    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    expect(list.tools).toEqual([desc]);
  });

  it('returns descriptors in registration order', async () => {
    const bus = await makeBus();
    const a = sampleDescriptor({ name: 'bash' });
    const b = sampleDescriptor({ name: 'read_file' });
    const c = sampleDescriptor({ name: 'write_file' });
    await bus.call('tool:register', ctx(), a);
    await bus.call('tool:register', ctx(), b);
    await bus.call('tool:register', ctx(), c);
    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    expect(list.tools.map((t) => t.name)).toEqual(['bash', 'read_file', 'write_file']);
  });

  it('zero-tools catalog returns { tools: [] }', async () => {
    const bus = await makeBus();
    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    expect(list.tools).toEqual([]);
  });

  it('duplicate name → PluginError with code duplicate-tool', async () => {
    const bus = await makeBus();
    await bus.call('tool:register', ctx(), sampleDescriptor({ name: 'bash' }));
    const err = await bus
      .call('tool:register', ctx(), sampleDescriptor({ name: 'bash' }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('duplicate-tool');
    expect(err.hookName).toBe('tool:register');
  });

  it('registration after tool:list → PluginError with code catalog-sealed', async () => {
    const bus = await makeBus();
    await bus.call('tool:register', ctx(), sampleDescriptor({ name: 'bash' }));
    // First list seals the catalog.
    await bus.call('tool:list', ctx(), {});
    const err = await bus
      .call('tool:register', ctx(), sampleDescriptor({ name: 'read_file' }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('catalog-sealed');
    // A later list still works and does not resurrect the rejected tool.
    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    expect(list.tools.map((t) => t.name)).toEqual(['bash']);
  });

  it('descriptor missing executesIn → invalid-payload', async () => {
    const bus = await makeBus();
    // Cast through unknown: we want to exercise the runtime guard even
    // though the typed signature would reject this at compile time.
    const bad = { name: 'bash', inputSchema: { type: 'object' } } as unknown as ToolDescriptor;
    const err = await bus.call('tool:register', ctx(), bad).catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
    expect(err.message).toMatch(/executesIn/);
  });

  it('descriptor with uppercase name → invalid-payload', async () => {
    const bus = await makeBus();
    const err = await bus
      .call('tool:register', ctx(), sampleDescriptor({ name: 'UPPER' }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
    expect(err.message).toMatch(/invalid tool name/);
  });

  it('descriptor with name starting with a digit → invalid-payload', async () => {
    const bus = await makeBus();
    const err = await bus
      .call('tool:register', ctx(), sampleDescriptor({ name: '1bash' }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
  });

  it('descriptor with traversal-like name "../escape" → invalid-payload', async () => {
    const bus = await makeBus();
    const err = await bus
      .call('tool:register', ctx(), sampleDescriptor({ name: '../escape' }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
  });

  it('descriptor with empty name → invalid-payload', async () => {
    const bus = await makeBus();
    const err = await bus
      .call('tool:register', ctx(), sampleDescriptor({ name: '' }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
  });

  it('descriptor with name longer than 64 chars → invalid-payload', async () => {
    const bus = await makeBus();
    const err = await bus
      .call('tool:register', ctx(), sampleDescriptor({ name: 'a'.repeat(65) }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
  });

  it('accepts namespaced name like "memory.recall"', async () => {
    const bus = await makeBus();
    await bus.call('tool:register', ctx(), sampleDescriptor({ name: 'memory.recall' }));
    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    expect(list.tools.map((t) => t.name)).toEqual(['memory.recall']);
  });

  it('accepts names with underscores and digits ("read_file", "tool2")', async () => {
    const bus = await makeBus();
    await bus.call('tool:register', ctx(), sampleDescriptor({ name: 'read_file' }));
    await bus.call('tool:register', ctx(), sampleDescriptor({ name: 'tool2' }));
    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    expect(list.tools.map((t) => t.name)).toEqual(['read_file', 'tool2']);
  });

  it('rejects executesIn value other than "sandbox" or "host"', async () => {
    const bus = await makeBus();
    const bad = {
      name: 'bash',
      inputSchema: { type: 'object' },
      executesIn: 'network',
    } as unknown as ToolDescriptor;
    const err = await bus.call('tool:register', ctx(), bad).catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
    expect(err.message).toMatch(/executesIn/);
  });

  it('rejects inputSchema that is not an object', async () => {
    const bus = await makeBus();
    const bad = {
      name: 'bash',
      inputSchema: 'not-an-object',
      executesIn: 'sandbox',
    } as unknown as ToolDescriptor;
    const err = await bus.call('tool:register', ctx(), bad).catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe('invalid-payload');
    expect(err.message).toMatch(/inputSchema/);
  });

  it('accepts host-tool descriptor (executesIn: "host")', async () => {
    const bus = await makeBus();
    await bus.call(
      'tool:register',
      ctx(),
      sampleDescriptor({ name: 'host_thing', executesIn: 'host' }),
    );
    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    expect(list.tools[0]).toMatchObject({ name: 'host_thing', executesIn: 'host' });
  });
});
