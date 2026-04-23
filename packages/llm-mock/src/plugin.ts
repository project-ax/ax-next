import type { LlmRequest, LlmResponse, Plugin } from '@ax/core';

const PLUGIN_NAME = '@ax/llm-mock';

export function llmMockPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['llm:call'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<LlmRequest, LlmResponse>(
        'llm:call',
        PLUGIN_NAME,
        async () => ({
          assistantMessage: { role: 'assistant', content: 'hello' },
          toolCalls: [],
        }),
      );
    },
  };
}
