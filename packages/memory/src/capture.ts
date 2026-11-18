import {
  MEMORY_PRE_CAPTURE_HOOK,
  MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS,
  MemoryPreCapturePayloadSchema,
  PluginError,
  type AgentContext,
  type HookBus,
  type MemoryPreCapturePayload,
  type Rejection,
} from '@ax/core';

import { PLUGIN_NAME } from './plugin-name.js';

/**
 * Logged at `info` when a `memory:pre-capture` subscriber refuses (TASK-908).
 * Bindings: `agentId`, `refusedBy` (the subscriber), `reason` (its own word
 * for why), plus `trigger` for an extraction pass or `tool` for a note. Ids
 * and codes only, never conversation text.
 */
export const CAPTURE_REFUSED_EVENT = 'memory_capture_refused';

/**
 * What `memory:pre-capture` answered: a refusal, or leave to go on with the
 * names of the people speaking in the conversation (TASK-1146). Exactly one
 * of the two, so a caller can't read names off a refusal.
 */
export type CaptureCheck =
  | { readonly refusal: Rejection; readonly speakerNames?: undefined }
  | { readonly refusal?: undefined; readonly speakerNames: readonly string[] };

/**
 * Asks whether memory may learn from `ctx`'s conversation (TASK-908), and who
 * is speaking in it (TASK-1146).
 *
 * Every extraction pass asks (`observe()` in plugin.ts), and since TASK-1094
 * so does `memory_note` before it writes, so a plugin that keeps a
 * conversation out of memory keeps the agent's own notes out too. One ask for
 * both, so they can't drift apart:
 *
 * - It asks about `ctx.conversationId` as the host set it, not
 *   `conversationOf(ctx)`. A routine run's rows are stored with no
 *   conversation (TASK-616), but a task check-in is refused by the
 *   conversation it runs in.
 * - No conversation, nothing to refuse and nobody to name: it doesn't ask,
 *   and answers no names.
 * - It asks with the conversation alone. A subscriber that labels the people
 *   speaking in the conversation's transcript adds their names, and memory
 *   reads the fire's final payload. In a turn that isn't private, no write
 *   path stores a statement whose subject is made of them
 *   (`breaksSpeakerRule` in audience.ts): the observer, `memory_note` and
 *   `recordFacts` all take them from here.
 * - Each subscriber gets MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS. One that
 *   throws, or misses the bound, is skipped by the bus and is no refusal
 *   (fails open; a subscriber that must fail closed refuses inside the
 *   bound, as @ax/routines and channel-slack do). Its names are skipped with
 *   it, so a channel that names its speakers refuses when its own lookup
 *   fails rather than throw.
 * - An answer that doesn't parse throws `invalid-return`, and the caller
 *   records nothing: memory can't tell which names it meant, and reading it
 *   as "no names" would file a speaker's words under their name. Not
 *   `invalid-payload`: `memory_note` maps that to "a field may be too long",
 *   which would have the model retry a fine note. The message names nothing
 *   from the answer; the names are untrusted display text, and never go in a
 *   log line, an error or a prompt.
 * - If the fire itself throws, so does this, and the caller records nothing.
 */
export async function captureCheck(bus: HookBus, ctx: AgentContext): Promise<CaptureCheck> {
  const conversationId = ctx.conversationId;
  if (typeof conversationId !== 'string' || conversationId === '') return { speakerNames: [] };
  const asked = await bus.fire<MemoryPreCapturePayload>(
    MEMORY_PRE_CAPTURE_HOOK,
    ctx,
    { conversationId },
    { subscriberTimeoutMs: MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS },
  );
  if (asked.rejected) return { refusal: asked };
  const answer = MemoryPreCapturePayloadSchema.safeParse(asked.payload);
  if (!answer.success) {
    throw new PluginError({
      code: 'invalid-return',
      plugin: PLUGIN_NAME,
      hookName: MEMORY_PRE_CAPTURE_HOOK,
      message: `${MEMORY_PRE_CAPTURE_HOOK} answered with a payload memory can't read, so memory learns nothing from this conversation rather than trust it`,
    });
  }
  // Frozen: the speaker rule reads each list once and keeps what it read
  // (`audience.ts`), which holds only while nobody changes the list.
  return { speakerNames: Object.freeze(answer.data.speakerNames ?? []) };
}
