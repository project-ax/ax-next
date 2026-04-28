import { z } from 'zod';
import { ChatMessageSchema, ToolCallSchema } from './actions.js';
import { ContentBlockSchema } from './content-blocks.js';

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
 *
 * `contentBlocks` and `role` are reserved for Task 3 of the Week 10–12 plan
 * (runner emits the assistant turn so @ax/conversations can persist it via
 * the chat:turn-end → conversations:append-turn subscriber). Both are
 * optional in the schema until the producer ships — Task 4 only LOCKS the
 * shape so the producer/consumer can land without further protocol churn.
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
  /** The turn's content blocks, in emission order. Optional until Task 3. */
  contentBlocks: z.array(ContentBlockSchema).optional(),
  /** The role the runner emitted this turn under. Optional until Task 3. */
  role: z.enum(['user', 'assistant', 'tool']).optional(),
});
export type EventTurnEnd = z.infer<typeof EventTurnEndSchema>;

/**
 * Terminal outcome of a chat, mirroring `@ax/core/src/types.ts` `AgentOutcome`
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
export type AgentOutcome = z.infer<typeof ChatOutcomeSchema>;

export const EventChatEndSchema = z.object({
  outcome: ChatOutcomeSchema,
});
export type EventChatEnd = z.infer<typeof EventChatEndSchema>;
