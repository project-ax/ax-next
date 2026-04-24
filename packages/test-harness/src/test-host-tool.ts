import { z } from 'zod';
import {
  PluginError,
  makeChatContext,
  type ChatContext,
  type Plugin,
  type ToolDescriptor,
} from '@ax/core';

const PLUGIN_NAME = '@ax/test-harness/test-host-echo';
const TOOL_NAME = 'test-host-echo';
const EXECUTE_HOOK = `tool:execute:${TOOL_NAME}` as const;

const InputSchema = z.object({
  text: z.string(),
});

const descriptor: ToolDescriptor = {
  name: TOOL_NAME,
  description: 'echo the input text back verbatim (test stub)',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  executesIn: 'host',
};

/**
 * A minimal host-executing tool used by tests that need to exercise the
 * `executesIn: 'host'` → `tool.execute-host` IPC → `tool:execute:<name>`
 * service-hook path without depending on a real provider.
 */
export function createTestHostToolPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [EXECUTE_HOOK],
      calls: ['tool:register'],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService<unknown, { output: string }>(
        EXECUTE_HOOK,
        PLUGIN_NAME,
        async (_ctx, raw) => {
          const parsed = InputSchema.safeParse(raw);
          if (!parsed.success) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              hookName: EXECUTE_HOOK,
              message: `invalid input: ${parsed.error.message}`,
              cause: parsed.error,
            });
          }
          return { output: parsed.data.text };
        },
      );

      // init-time ctx: tool:register doesn't read ctx fields (pure registry
      // write), but bus.call still needs a ChatContext envelope. Synthesize
      // a minimal one so this plugin stays free of sibling-plugin imports.
      const ctx: ChatContext = makeChatContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'init',
      });
      await bus.call<ToolDescriptor, { ok: true }>('tool:register', ctx, descriptor);
    },
  };
}
