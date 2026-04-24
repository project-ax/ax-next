import { makeChatContext, type Plugin, type ToolDescriptor } from '@ax/core';
import { bashToolDescriptor } from './descriptor.js';

const PLUGIN_NAME = '@ax/tool-bash';

/**
 * Descriptor-only plugin: declares the `bash` tool to the dispatcher. The
 * actual execution lives sandbox-side in `@ax/tool-bash-impl` (Task 9),
 * so this plugin registers zero service hooks — it only CALLS
 * `tool:register` during init. That's why `registers: []`: the Week 4-6
 * `tool:execute:bash` service is gone, and the umbrella it fed has been
 * retired along with the host-side tool-execution code path.
 */
export function createToolBashPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: ['tool:register'],
      subscribes: [],
    },
    async init({ bus }) {
      // init-time ctx: the tool:register service doesn't read ctx fields
      // (it's a pure registry write), but bus.call still needs a
      // ChatContext envelope. We synthesize a minimal one so the plugin
      // stays free of imports from any other plugin (I2).
      const ctx = makeChatContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'init',
      });
      await bus.call<ToolDescriptor, { ok: true }>(
        'tool:register',
        ctx,
        bashToolDescriptor,
      );
    },
  };
}
