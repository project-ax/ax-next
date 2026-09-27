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

export type MemoryNoteErrorCode = 'invalid-input' | 'forbidden' | 'memory-unavailable';

// A host tool can't flag its own result as an error to the model (only a
// thrown error does, and that path redacts the message), so a failure's text
// must say, unmistakably and on its own, that nothing was saved.
export type MemoryNoteResult =
  | { ok: true }
  | { ok: false; error: MemoryNoteErrorCode; message: string };

export const MEMORY_NOTE_DESCRIPTOR: ToolDescriptor = {
  name: 'memory_note',
  description:
    'Save a durable statement to memory with agent provenance. Human corrections take precedence over agent notes. ' +
    'The result is { "ok": true } only when the note was saved; any other result means NOTHING was saved — ' +
    'say so to the person rather than claiming it was saved.',
  activityPhrase: 'Saving a note to memory',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      about: {
        type: 'string',
        minLength: 1,
        description:
          'The subject of the statement. Use the literal word `user` for the person you are talking with ' +
          '(not "you" or their name); otherwise the name of the person or thing the statement is about.',
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
        description:
          'Optional. A date like 2026-09-27, or a date-time with seconds and an explicit timezone like ' +
          '2026-09-27T14:00:00Z. Omit to mean now.',
      },
    },
    required: ['about', 'relation', 'value'],
    additionalProperties: false,
  },
};

const ALLOWED_KEYS = new Set(['about', 'relation', 'value', 'when']);

const NOT_SAVED =
  'NOT SAVED: nothing was written to memory — do not tell the person it was saved.';

const FIELDS_MESSAGE = 'about, relation and value must be non-empty strings.';
const KEYS_MESSAGE = 'unexpected field(s) — only about, relation, value, when are accepted.';
const WHEN_MESSAGE =
  'when must be a date like 2026-09-27 or a date-time with seconds and an explicit timezone ' +
  'like 2026-09-27T14:00:00Z or 2026-09-27T14:00:00-07:00, or be omitted to mean now.';

const FAILURE_MESSAGES: Record<MemoryNoteErrorCode, string> = {
  // Engine-side rejection: deliberately generic — the engine's own error text
  // is never relayed into model-visible output.
  'invalid-input':
    'memory rejected the statement (a field may be too long or contain control characters).',
  forbidden: "the person isn't allowed to write this agent's memory.",
  'memory-unavailable': "memory couldn't be reached right now; you may retry later.",
};

// A refusal authored by this tool. Its message is one of the fixed strings
// above and never carries caller-supplied keys or values, so it is safe to
// return to the model.
class NoteInputError extends PluginError {
  readonly toolMessage: string;
  constructor(toolMessage: string) {
    super({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: MEMORY_NOTE_TOOL_HOOK,
      message: `memory_note refused its input: ${toolMessage}`,
    });
    this.toolMessage = toolMessage;
  }
}

// Mirrors the engines' contract for FactStatementInput.when
// (@ax/memory-facts-contract): an instant with seconds and an explicit Z or
// +/-HH:MM offset. The tool checks it itself so the refusal can say what was
// wrong without relaying engine error text into model-visible output.
const EXPLICIT_OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The `when` to record: a real calendar date becomes midnight UTC. */
function normalizeWhen(when: unknown): string {
  if (typeof when !== 'string' || when.trim() === '') throw new NoteInputError(WHEN_MESSAGE);
  const dateOnly = DATE_ONLY.exec(when);
  if (dateOnly !== null) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
      throw new NoteInputError(WHEN_MESSAGE);
    }
    return `${when}T00:00:00Z`;
  }
  if (!EXPLICIT_OFFSET_ISO.test(when) || !Number.isFinite(Date.parse(when))) {
    throw new NoteInputError(WHEN_MESSAGE);
  }
  return when;
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
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new NoteInputError(FIELDS_MESSAGE);
        }
        const input = raw as Record<string, unknown>;
        if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) {
          throw new NoteInputError(KEYS_MESSAGE);
        }
        for (const field of ['about', 'relation', 'value'] as const) {
          const value = input[field];
          if (typeof value !== 'string' || value.trim() === '') {
            throw new NoteInputError(FIELDS_MESSAGE);
          }
        }
        const when = input.when === undefined ? undefined : normalizeWhen(input.when);

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
              when: when ?? new Date().toISOString(),
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
        const error: MemoryNoteErrorCode =
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
        const detail = err instanceof NoteInputError ? err.toolMessage : FAILURE_MESSAGES[error];
        return { ok: false, error, message: `${NOT_SAVED} ${detail}` };
      }
    },
  );
  await bus.call(
    'tool:register',
    makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' }),
    MEMORY_NOTE_DESCRIPTOR,
  );
}
