import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
  type ToolDescriptor,
} from '@ax/core';

import { resolveMemoryAccess } from './access.js';
import { isMissingCredential, memoryFailureEvent, NOTE_FAILED_EVENT } from './failure.js';
import { PLUGIN_NAME } from './plugin-name.js';
import { deriveSlot } from './slots.js';
import { rewriteSpeaker } from './subject.js';

export const MEMORY_NOTE_TOOL_HOOK = 'tool:execute:memory_note';

export interface MemoryNoteInput {
  about: string;
  relation: string;
  value: string;
  when?: string;
}

export type MemoryNoteResult =
  | { ok: true }
  | { error: 'invalid-input' | 'forbidden' | 'memory-unavailable' };

export const MEMORY_NOTE_DESCRIPTOR: ToolDescriptor = {
  name: 'memory_note',
  description:
    'Save a durable statement to memory with agent provenance. Human corrections take precedence over agent notes.',
  activityPhrase: 'Saving a note to memory',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      about: {
        type: 'string',
        minLength: 1,
        description: 'The subject of the statement. Use user for the person speaking.',
      },
      relation: {
        type: 'string',
        minLength: 1,
        description: 'The relationship or attribute being recorded.',
      },
      value: {
        type: 'string',
        minLength: 1,
        description: 'The value or observation to remember.',
      },
      when: {
        type: 'string',
        minLength: 1,
        description: 'Optional date-time with an explicit timezone. Defaults to now.',
      },
    },
    required: ['about', 'relation', 'value'],
    additionalProperties: false,
  },
};

const ALLOWED_KEYS = new Set(['about', 'relation', 'value', 'when']);

function invalid(): PluginError {
  return new PluginError({
    code: 'invalid-payload',
    plugin: PLUGIN_NAME,
    hookName: MEMORY_NOTE_TOOL_HOOK,
    message: 'memory_note requires non-empty about, relation and value strings',
  });
}

export async function registerMemoryNote(
  bus: HookBus,
  onFactsChanged: (ctx: AgentContext) => void,
): Promise<void> {
  bus.registerService<{ input?: unknown }, MemoryNoteResult>(
    MEMORY_NOTE_TOOL_HOOK,
    PLUGIN_NAME,
    async (ctx, call) => {
      try {
        const raw = call?.input;
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
        const input = raw as Record<string, unknown>;
        if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) throw invalid();
        for (const field of ['about', 'relation', 'value'] as const) {
          const value = input[field];
          if (typeof value !== 'string' || value.trim() === '') throw invalid();
        }
        if (
          input.when !== undefined &&
          (typeof input.when !== 'string' || input.when.trim() === '')
        ) {
          throw invalid();
        }

        const access = await resolveMemoryAccess(bus, ctx);
        const slot = deriveSlot(input.relation as string);
        const result = await bus.call<
          { statements: Array<Record<string, unknown>> },
          { records?: Array<{ id?: unknown }> } | null
        >('memory:facts:record', ctx, {
          statements: [
            {
              about: rewriteSpeaker(input.about as string, access.userId),
              relation: input.relation,
              value: input.value,
              when: (input.when as string | undefined) ?? new Date().toISOString(),
              ...(slot !== null ? { slot } : {}),
              provenance: 'agent',
              ownerUserId: access.userId,
              ...(ctx.conversationId !== undefined
                ? { conversationId: ctx.conversationId }
                : {}),
            },
          ],
        });
        const records = result === null || typeof result !== 'object' ? undefined : result.records;
        if (
          !Array.isArray(records) ||
          records.length !== 1 ||
          typeof records[0]?.id !== 'string' ||
          records[0].id.trim() === ''
        ) {
          throw new PluginError({
            code: 'invalid-return',
            plugin: PLUGIN_NAME,
            hookName: MEMORY_NOTE_TOOL_HOOK,
            message: 'memory:facts:record returned no usable record for a single-statement note',
          });
        }
        onFactsChanged(ctx);
        return { ok: true };
      } catch (err) {
        const error: Extract<MemoryNoteResult, { error: string }>['error'] =
          err instanceof PluginError && err.code === 'invalid-payload'
            ? 'invalid-input'
            : err instanceof PluginError && err.code === 'forbidden'
              ? 'forbidden'
              : 'memory-unavailable';
        try {
          ctx.logger[isMissingCredential(err) ? 'error' : 'warn'](
            memoryFailureEvent(err, NOTE_FAILED_EVENT),
            { agentId: ctx.agentId, path: 'note', reason: error },
          );
        } catch {
        }
        return { error };
      }
    },
  );
  await bus.call(
    'tool:register',
    makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' }),
    MEMORY_NOTE_DESCRIPTOR,
  );
}
