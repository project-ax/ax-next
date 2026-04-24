import type { Plugin, ToolDescriptor } from '@ax/core';
import { ToolCatalog } from './catalog.js';

const PLUGIN_NAME = '@ax/tool-dispatcher';

/**
 * Tool dispatcher — owns the single source of truth for the tool catalog
 * (invariant I4). Tool-provider plugins declare their tools by calling
 * `tool:register` during their own `init()`. The agent runtime reads the
 * catalog via `tool:list` (which seals it on first call, so all
 * registrations must complete before any list query).
 *
 * The dispatcher does NOT execute tools. After 6.5a the shape is:
 *  - `executesIn: 'sandbox'` tools are dispatched inside the sandbox by
 *    `@ax/agent-runner-core`'s local dispatcher.
 *  - `executesIn: 'host'` tools (none in 6.5a) round-trip through the
 *    `tool.execute-host` IPC action and land on whichever plugin
 *    registered `tool:execute:${name}` on the host.
 *
 * So there is no `tool:execute` umbrella anymore — the Week 4-6 fan-out
 * service has been retired along with its caller.
 */
export function createToolDispatcherPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['tool:register', 'tool:list'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      const catalog = new ToolCatalog();

      bus.registerService<ToolDescriptor, { ok: true }>(
        'tool:register',
        PLUGIN_NAME,
        async (_ctx, input) => {
          catalog.register(input);
          return { ok: true };
        },
      );

      bus.registerService<Record<string, never>, { tools: ToolDescriptor[] }>(
        'tool:list',
        PLUGIN_NAME,
        async () => ({ tools: catalog.list() }),
      );
    },
  };
}
