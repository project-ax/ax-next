import { describe, it, expect } from 'vitest';
import {
  HookBus,
  makeAgentContext,
  createLogger,
  type ToolDescriptor,
} from '@ax/core';
// Integration test: wire the dispatcher alongside tool-bash so the full
// tool:register path is exercised. Test-only — runtime package.json deps
// stay free of cross-plugin references, so the no-restricted-imports
// rule still protects every non-test file.
import { createToolDispatcherPlugin } from '@ax/tool-dispatcher';
import { createToolBashPlugin, bashToolDescriptor } from '../index.js';

const ctx = () =>
  makeAgentContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
  });

describe('tool-bash (descriptor-only)', () => {
  it('descriptor declares executesIn: "sandbox" and the expected input shape', () => {
    expect(bashToolDescriptor.name).toBe('bash');
    expect(bashToolDescriptor.executesIn).toBe('sandbox');
    const required = (bashToolDescriptor.inputSchema as { required: string[] }).required;
    expect(required).toContain('command');
    const props = (bashToolDescriptor.inputSchema as {
      properties: Record<string, unknown>;
    }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['command', 'timeoutMs']));
  });

  it('plugin.init() calls tool:register with the bash descriptor', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    await createToolBashPlugin().init({ bus, config: {} });

    const list = await bus.call<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      ctx(),
      {},
    );
    expect(list.tools).toHaveLength(1);
    expect(list.tools[0]).toEqual(bashToolDescriptor);
  });

  it('plugin registers zero service hooks (descriptor-only)', async () => {
    const bus = new HookBus();
    await createToolDispatcherPlugin().init({ bus, config: {} });
    await createToolBashPlugin().init({ bus, config: {} });
    // The Week 4-6 tool:execute:bash service is gone — execution lives
    // sandbox-side in @ax/tool-bash-impl (arriving in Task 9).
    expect(bus.hasService('tool:execute:bash')).toBe(false);
    expect(bus.hasService('tool:execute')).toBe(false);
  });

  it('manifest declares registers: [] and calls: ["tool:register"]', () => {
    const plugin = createToolBashPlugin();
    expect(plugin.manifest.registers).toEqual([]);
    expect(plugin.manifest.calls).toEqual(['tool:register']);
    expect(plugin.manifest.subscribes).toEqual([]);
  });
});
