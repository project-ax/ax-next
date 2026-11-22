import {
  audienceOf,
  isOutsiderTurn,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
  type ToolDescriptor,
} from '@ax/core';

import { resolveMemoryAccess } from './access.js';
import {
  recordFacts,
  SPEAKER_RULE_READS_AT_MOST,
  speakerScope,
  speakerSubject,
  type SpeakerScope,
} from './audience.js';
import { CAPTURE_REFUSED_EVENT, captureCheck } from './capture.js';
import { conversationField } from './conversation.js';
import { isMissingCredential, memoryFailureEvent, NOTE_FAILED_EVENT } from './failure.js';
import { PLUGIN_NAME } from './plugin-name.js';
import { deriveSlot } from './slots.js';
import { findActiveExtractedTwin, type PriorRow, type TwinCandidate } from './twins.js';

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
const ABOUT_TOO_LONG_MESSAGE = `about must be at most ${SPEAKER_RULE_READS_AT_MOST} characters.`;
const KEYS_MESSAGE = 'unexpected field(s) — only about, relation, value, when are accepted.';
const WHEN_MESSAGE =
  'when must be a date like 2026-09-27 or a date-time with seconds and an explicit timezone ' +
  'like 2026-09-27T14:00:00Z or 2026-09-27T14:00:00-07:00, or be omitted to mean now.';
/**
 * The refusal of a note about a person in a turn that keeps the speaker rule
 * (a personal agent's shared turn, any outsider's turn): the speaker could be
 * anyone in the room, so no note about a person is saved at all.
 */
export const PERSON_IN_SHARED_MESSAGE =
  "In a shared conversation, don't save notes about a person: not as `user`, not under their name, and " +
  "not as a personal detail in the value. If it's about the work (a project, a decision, a process, or who owns " +
  'what), save it again with the work as `about`, for example `team_standup`.';
/**
 * The refusal of a note under a person key in a team agent's member turn
 * (TASK-1204): a note about the person talking is saved under their own key,
 * so this only answers a subject that names some other person's key, or one
 * cased or padded so it can't be read as `user`. It says how to file the note
 * instead.
 */
export const TEAM_PERSON_KEY_MESSAGE =
  "Save it again with `user` as `about` if it's about the person you're talking with, " +
  "or the name of the person or thing it's about. Don't write a `user:` id.";

/**
 * The words a note `speakerSubject` files nowhere is refused with, by the
 * turn's speaker scope. A private turn files every subject, so it never gets
 * here; were it to, it would get the stricter words.
 */
function unfiledMessage(scope: SpeakerScope): string {
  return scope === 'team' ? TEAM_PERSON_KEY_MESSAGE : PERSON_IN_SHARED_MESSAGE;
}
// The same words whoever refused and why: that goes to the log, not the
// model. True for every refusal (TASK-1094 PR B review F4): a switch turned
// off, a conversation memory never learns from, a check that failed or timed
// out, a task check-in. So it names no cause, and never says memory is off.
const NOT_SAVED_HERE_MESSAGE = "Notes aren't being saved in this conversation right now.";

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
// return to the model. `forbidden` for a note the turn may not save at all.
class NoteInputError extends PluginError {
  readonly toolMessage: string;
  constructor(toolMessage: string, code: 'invalid-payload' | 'forbidden' = 'invalid-payload') {
    super({
      code,
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

/**
 * A note that restates an extracted row, and so was not written (TASK-649).
 * `debug`: ordinary, the fact is already in memory.
 */
export const NOTE_TWIN_EVENT = 'memory_note_twin';

/** The conversation's rows, active and closed — `plugin.ts`'s `readPriorRows`. */
export type NotePriorRowsFn = (
  ctx: AgentContext,
  query: { abouts: string[]; ownerUserId: string; conversationId: string },
) => Promise<PriorRow[]>;

/**
 * The REVERSE twin check (TASK-649, `twins.ts`): does this conversation
 * already hold an ACTIVE extracted row saying what the note says? Then the
 * note is not written — the fact is in memory, once, and a Fix, Undo, Forget
 * or Forget-Undo acts on the only row there is. The extracted row survives
 * with its `sourceRole`, which is what lets the person's own restatement of
 * a never-right value resurface (TASK-648).
 *
 * Only a conversation's note is checked (a routine run has none, TASK-616).
 * Fails OPEN: a read that throws is reported, with its cause, and the note
 * is written as before — a duplicate is the lesser loss.
 */
async function restatesExtractedRow(
  ctx: AgentContext,
  priorRows: NotePriorRowsFn,
  ownerUserId: string,
  note: TwinCandidate,
): Promise<boolean> {
  const { conversationId } = conversationField(ctx);
  if (conversationId === undefined) return false;
  let prior: PriorRow[];
  try {
    prior = await priorRows(ctx, { abouts: [note.about], ownerUserId, conversationId });
  } catch (err) {
    ctx.logger.warn(NOTE_FAILED_EVENT, {
      agentId: ctx.agentId,
      path: 'note',
      reason: 'twin-check-failed',
      err: err instanceof Error ? err : new Error(String(err)),
    });
    return false;
  }
  if (findActiveExtractedTwin(note, prior) === undefined) return false;
  ctx.logger.debug(NOTE_TWIN_EVENT, { agentId: ctx.agentId, path: 'note' });
  return true;
}

export async function registerMemoryNote(
  bus: HookBus,
  onFactsChanged: (ctx: AgentContext) => void,
  priorRows: NotePriorRowsFn,
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
        // Both engines refuse an `about` this long in every audience, so
        // nothing is lost by saying so here, once, for every turn. Without
        // it a shared turn's long subject would be filed nowhere, unread, and
        // answer a refusal that says the note is about a person.
        if ((input.about as string).length > SPEAKER_RULE_READS_AT_MOST) {
          throw new NoteInputError(ABOUT_TOO_LONG_MESSAGE);
        }
        const when = input.when === undefined ? undefined : normalizeWhen(input.when);
        // TASK-1204: where a note about a person is filed depends on whose
        // memory this is (`speakerScope`), so a turn that isn't the owner's
        // own reads that first (one `agents:resolve`). The owner's own turn is
        // `'private'` on any agent, so it keeps TASK-1094's order: the ask,
        // then access.
        let access =
          audienceOf(ctx) !== 'private' || isOutsiderTurn(ctx) ? await resolveMemoryAccess(bus, ctx) : undefined;
        const scope: SpeakerScope = access === undefined ? 'private' : speakerScope(ctx, access);
        // A subject no name can file: in a turn that keeps the speaker rule
        // (TASK-1091) the person a note calls `user` could be anyone in the
        // room, and in a team agent's member turn (TASK-1204) `User` or
        // another person's key names someone the speaker can't vouch for.
        // Refused on the subject AS WRITTEN, before the ask (TASK-1094's
        // order) and before any engine call, so nothing is read or written.
        // `recordFacts` would refuse it anyway; refusing here says why, in
        // words the model can pass on. The same `speakerSubject` as the
        // observer and `recordFacts`, so the three can't drift (TASK-1136).
        // This is the rule with no names; the names come with the ask.
        if (access !== undefined && speakerSubject(scope, input.about as string, access.userId, []) === undefined) {
          throw new NoteInputError(unfiledMessage(scope), 'forbidden');
        }
        // TASK-1094: ask `memory:pre-capture` first, as every extraction
        // pass does (`captureCheck`). A plugin that keeps a conversation
        // out of memory keeps the agent's own notes in it out too; otherwise
        // the agent could write down what memory was told not to learn.
        // After the input and person checks, so those refusals still say
        // what's wrong; before the engine, so a refused note reads nothing
        // and writes nothing. An answer memory can't read throws
        // `invalid-return`, and the note is not saved.
        const check = await captureCheck(bus, ctx);
        if (check.refusal !== undefined) {
          ctx.logger.info(CAPTURE_REFUSED_EVENT, {
            agentId: ctx.agentId,
            refusedBy: check.refusal.source,
            reason: check.refusal.reason,
            tool: MEMORY_NOTE_DESCRIPTOR.name,
          });
          throw new NoteInputError(NOT_SAVED_HERE_MESSAGE, 'forbidden');
        }
        access ??= await resolveMemoryAccess(bus, ctx);
        // TASK-1146: the answer names the people speaking in the
        // conversation. A note filed under one of their names (`vinay`) is a
        // note about a person: refused like `user`, with the same words, in a
        // turn that keeps the speaker rule, and filed under the member's own
        // key, like `user`, in a team agent's member turn (TASK-1204). A
        // private turn files `user` under the owner's key, as always (design
        // §3.2). Before the twin check, so it compares the key the note is
        // filed under.
        const about = speakerSubject(scope, input.about as string, access.userId, check.speakerNames);
        if (about === undefined) {
          throw new NoteInputError(unfiledMessage(scope), 'forbidden');
        }
        if (await restatesExtractedRow(ctx, priorRows, access.userId, {
          about,
          relation: input.relation as string,
          value: input.value as string,
        })) {
          return { ok: true };
        }
        const slot = deriveSlot(input.relation as string);
        // `recordFacts`, like every engine write: it stamps the turn's
        // audience on the note (TASK-1091), and sends it only because `about`
        // is already where `speakerSubject` files it. Handed the names this
        // note was answered with, so a note asks once (TASK-1146), and the
        // access resolved above, so it knows whose memory this is (TASK-1204).
        const result = await recordFacts<{ records?: Array<{ id?: unknown }> }>(
          bus,
          ctx,
          access,
          'memory:facts:record',
          {
            statements: [
              {
                about,
                relation: input.relation,
                value: input.value,
                when: when ?? new Date().toISOString(),
                ...(slot !== null ? { slot } : {}),
                provenance: 'agent',
                ownerUserId: access.userId,
                // Not a routine run's hidden conversation (TASK-616).
                ...conversationField(ctx),
              },
            ],
          },
          check.speakerNames,
        );
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
        // A refusal this tool makes on purpose (a note about a person the turn
        // files nowhere, a conversation memory may not learn from) is a
        // decision, not a failure: info, so a "remember off" channel isn't a
        // stream of warns. Everything else, a resolver's own `forbidden`
        // included, stays warn.
        const deliberate = err instanceof NoteInputError && err.code === 'forbidden';
        try {
          ctx.logger[isMissingCredential(err) ? 'error' : deliberate ? 'info' : 'warn'](
            memoryFailureEvent(err, NOTE_FAILED_EVENT),
            {
              agentId: ctx.agentId,
              path: 'note',
              reason: error,
              // Which hook faulted and how, never the message. Only for this
              // plugin's own errors: their code and hook are fixed strings,
              // while another plugin's code is text we don't control.
              ...(err instanceof PluginError && err.plugin === PLUGIN_NAME
                ? { code: err.code, hookName: err.hookName }
                : {}),
            },
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
