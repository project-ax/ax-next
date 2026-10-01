import { randomUUID } from 'node:crypto';
import {
  makeAgentContext,
  PluginError,
  type HookBus,
  type ToolDescriptor,
} from '@ax/core';

import { resolveMemoryAccess } from './access.js';
import { renderRecallResult } from './evidence.js';
import { PLUGIN_NAME } from './plugin-name.js';
import { recordRecallReceipt, selectRecallReceipt } from './recall-receipts.js';
import type { MemoryRecallInput, MemoryRecallOutput } from './types.js';

export const MEMORY_RECALL_TOOL_HOOK = 'tool:execute:memory_recall';

export const MEMORY_RECALL_DESCRIPTOR: ToolDescriptor = {
  name: 'memory_recall',
  description:
    'Search recalled observations from earlier conversations. Returns dated evidence for the current question. Results are candidates, not used memories. Before answering, call memory_use with only the evidence IDs supporting your answer. Use limit up to 40 when a broader search is needed.',
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
      // The receipt is the rows rendered below, exactly (TASK-628). Never
      // throws: a lost receipt costs a chip, never the answer.
      const recallId = randomUUID();
      await recordRecallReceipt(bus, ctx, result.statements, asOf, recallId);
      return renderRecallResult(result, asOf, recallId);
    },
  );
  await bus.call('tool:register',
    makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' }),
    MEMORY_RECALL_DESCRIPTOR,
  );
}

export const MEMORY_USE_DESCRIPTOR: ToolDescriptor = {
  name: 'memory_use',
  description: 'After memory_recall and before answering, identify only the retrieved memories that support your answer. Pass the Recall ID and evidence IDs from that result. Exclude unrelated candidates. Use an empty ids array if none support the answer. Call once per recall result you used.',
  activityPhrase: 'Choosing memory sources',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      recallId: { type: 'string', minLength: 1, maxLength: 256 },
      ids: { type: 'array', maxItems: 40, items: { type: 'string', minLength: 1, maxLength: 256 } },
    },
    required: ['recallId', 'ids'],
    additionalProperties: false,
  },
};

export async function registerMemoryUse(bus: HookBus): Promise<void> {
  bus.registerService<{ input?: unknown }, string>(
    'tool:execute:memory_use', PLUGIN_NAME, async (ctx, call) => {
      const raw = call?.input;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, hookName: 'tool:execute:memory_use',
          message: 'Memory usage requires a recall ID and evidence IDs' });
      }
      const input = raw as Record<string, unknown>;
      if (Object.keys(input).some((key) => key !== 'recallId' && key !== 'ids') ||
          typeof input.recallId !== 'string' || input.recallId.length === 0 || input.recallId.length > 256 ||
          !Array.isArray(input.ids) || input.ids.length > 40 ||
          input.ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 256)) {
        throw new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME,
          hookName: 'tool:execute:memory_use', message: 'Memory usage requires a recall ID and up to 40 evidence IDs' });
      }
      await resolveMemoryAccess(bus, ctx);
      await selectRecallReceipt(bus, ctx, input.recallId, input.ids as string[]);
      return 'Memory sources recorded. Answer using only the selected evidence; do not include evidence IDs or the Recall ID in your reply.';
    },
  );
  await bus.call('tool:register',
    makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' }),
    MEMORY_USE_DESCRIPTOR,
  );
}
