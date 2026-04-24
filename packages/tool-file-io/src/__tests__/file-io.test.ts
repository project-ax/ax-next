import { describe, it, expect } from 'vitest';
import {
  HookBus,
  makeChatContext,
  createLogger,
  type ToolDescriptor,
} from '@ax/core';
// Integration test: wire the dispatcher alongside tool-file-io so the
// full tool:register path is exercised. Test-only — runtime package.json
// deps stay free of cross-plugin references.
// eslint-disable-next-line no-restricted-imports
import { createToolDispatcherPlugin } from '@ax/tool-dispatcher';
import {
  createToolFileIoPlugin,
  readFileToolDescriptor,
  writeFileToolDescriptor,
} from '../index.js';

const ctx = () =>
  makeChatContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
  });

describe('tool-file-io (descriptor-only)', () => {
  it('read_file descriptor declares executesIn: "sandbox" and the expected input shape', () => {
    expect(readFileToolDescriptor.name).toBe('read_file');
    expect(readFileToolDescriptor.executesIn).toBe('sandbox');
    const required = (readFileToolDescriptor.inputSchema as { required: string[] }).required;
    expect(required).toEqual(['path']);
    const props = (readFileToolDescriptor.inputSchema as {
      properties: Record<string, unknown>;
    }).properties;
    expect(Object.keys(props)).toEqual(['path']);
  });

  it('write_file descriptor declares executesIn: "sandbox" and the expected input shape', () => {
    expect(writeFileToolDescriptor.name).toBe('write_file');
    expect(writeFileToolDescriptor.executesIn).toBe('sandbox');
    const required = (writeFileToolDescriptor.inputSchema as { required: string[] }).required;
    expect(required).toEqual(['path', 'content']);
    const props = (writeFileToolDescriptor.inputSchema as {
      properties: Record<string, unknown>;
    }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['path', 'content']));
  });

  it('plugin.init() registers both descriptors in order (read_file, write_file)', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    await createToolFileIoPlugin().init({ bus, config: {} });

    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    expect(list.tools.map((t) => t.name)).toEqual(['read_file', 'write_file']);
    expect(list.tools[0]).toEqual(readFileToolDescriptor);
    expect(list.tools[1]).toEqual(writeFileToolDescriptor);
  });

  it('plugin registers zero service hooks (descriptor-only)', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    await createToolFileIoPlugin().init({ bus, config: {} });
    // Execution moves to @ax/tool-file-io-impl in Task 10.
    expect(bus.hasService('tool:execute:read_file')).toBe(false);
    expect(bus.hasService('tool:execute:write_file')).toBe(false);
  });

  it('manifest declares registers: [] and calls: ["tool:register"]', () => {
    const plugin = createToolFileIoPlugin();
    expect(plugin.manifest.registers).toEqual([]);
    expect(plugin.manifest.calls).toEqual(['tool:register']);
    expect(plugin.manifest.subscribes).toEqual([]);
  });
});
