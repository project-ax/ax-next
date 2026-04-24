import type { Plugin } from '@ax/core';

const PLUGIN_NAME = '@ax/llm-anthropic';

export interface LlmAnthropicConfig {
  model?: string;
  maxTokens?: number;
}

export function createLlmAnthropicPlugin(_cfg: LlmAnthropicConfig = {}): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['llm:call'],
      calls: [],
      subscribes: [],
    },
    async init() {
      // Implemented in Task 6.2.
    },
  };
}
