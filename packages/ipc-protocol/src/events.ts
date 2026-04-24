import { z } from 'zod';
import { ChatMessageSchema, ToolCallSchema } from './actions.js';

// ---------------------------------------------------------------------------
// Sandbox → host events (fire-and-forget)
//
// No response envelope: the host receives, validates, and dispatches to
// subscribers. If a subscriber rejects, that's a subscriber concern —
// the emitter does not block on it.
//
// Envelopes are not `.strict()`: events are the most likely surface to
// grow additive fields, and we want those adds to be forward-compatible.
// ---------------------------------------------------------------------------

/**
 * Incremental output from the current LLM turn. Schema only in 6.5a —
 * runtime wiring arrives in 6.5b once the streaming plumbing is live.
 */
export const EventStreamChunkSchema = z.object({
  reqId: z.string(),
  text: z.string(),
  kind: z.enum(['text', 'thinking']),
});
export type EventStreamChunk = z.infer<typeof EventStreamChunkSchema>;

/**
 * Post-tool-call observation: the actual input the tool ran with and the
 * raw output. `output` is opaque at the protocol layer — each tool defines
 * its own return shape.
 */
export const EventToolPostCallSchema = z.object({
  call: ToolCallSchema,
  output: z.unknown(),
  durationMs: z.number().nonnegative().optional(),
});
export type EventToolPostCall = z.infer<typeof EventToolPostCallSchema>;

/**
 * End of one agent turn. `reason` distinguishes "waiting on the user" from
 * "fully done" from "terminated abnormally" — the orchestrator branches on
 * this to decide whether to keep the session alive.
 */
export const EventTurnEndSchema = z.object({
  reqId: z.string().optional(),
  reason: z.enum(['user-message-wait', 'error', 'complete']),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type EventTurnEnd = z.infer<typeof EventTurnEndSchema>;

/**
 * Terminal outcome of a chat, mirroring `@ax/core/src/types.ts` `ChatOutcome`
 * but declared locally to keep this package independent of the kernel.
 */
export const ChatOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('complete'),
    messages: z.array(ChatMessageSchema),
  }),
  z.object({
    kind: z.literal('terminated'),
    reason: z.string(),
    error: z.unknown().optional(),
  }),
]);
export type ChatOutcome = z.infer<typeof ChatOutcomeSchema>;

export const EventChatEndSchema = z.object({
  outcome: ChatOutcomeSchema,
});
export type EventChatEnd = z.infer<typeof EventChatEndSchema>;
