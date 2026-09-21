import {
  makeAgentContext,
  PluginError,
  type HookBus,
  type ToolDescriptor,
} from '@ax/core';

import { renderRecallResult } from './evidence.js';
import { PLUGIN_NAME } from './plugin-name.js';
import type { MemoryRecallInput, MemoryRecallOutput } from './types.js';

export const MEMORY_RECALL_TOOL_HOOK = 'tool:execute:memory_recall';

export const MEMORY_RECALL_DESCRIPTOR: ToolDescriptor = {
  name: 'memory_recall',
  description:
    'Search recalled observations from earlier conversations. Returns dated evidence for the current question. Use limit up to 40 when a broader search is needed.',
  activityPhrase: 'Searching memory',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 40, default: 15 },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

function invalid(): PluginError {
  return new PluginError({
    code: 'invalid-payload',
    plugin: PLUGIN_NAME,
    hookName: MEMORY_RECALL_TOOL_HOOK,
    message: 'Memory recall requires a non-empty query and a positive limit',
  });
}

export async function registerMemoryRecall(bus: HookBus): Promise<void> {
  bus.registerService<{ input?: unknown }, string>(
    MEMORY_RECALL_TOOL_HOOK,
    PLUGIN_NAME,
    async (ctx, call) => {
      const raw = call?.input;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
      const input = raw as Record<string, unknown>;
      if (
        Object.keys(input).some((key) => key !== 'query' && key !== 'limit') ||
        typeof input.query !== 'string' ||
        input.query.trim() === ''
      ) {
        throw invalid();
      }
      if (
        input.limit !== undefined &&
        (typeof input.limit !== 'number' ||
          !Number.isFinite(input.limit) ||
          !Number.isInteger(input.limit) ||
          input.limit < 1)
      ) {
        throw invalid();
      }
      const limit = Math.min(40, Math.floor((input.limit as number | undefined) ?? 15));
      const asOf = new Date().toISOString();
      const result = await bus.call<MemoryRecallInput, MemoryRecallOutput>('memory:recall', ctx, {
        query: input.query,
        limit,
      });
      if (result == null || !Array.isArray(result.statements) || !Array.isArray(result.degraded)) {
        throw new PluginError({
          code: 'invalid-return',
          plugin: PLUGIN_NAME,
          hookName: MEMORY_RECALL_TOOL_HOOK,
          message: 'Memory recall returned an unreadable result',
        });
      }
      return renderRecallResult(result, asOf);
    },
  );
  await bus.call('tool:register',
    makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' }),
    MEMORY_RECALL_DESCRIPTOR,
  );
}
