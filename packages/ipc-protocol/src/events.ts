import { z } from 'zod';
import { AgentMessageSchema, ToolCallSchema } from './actions.js';
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
 * Incremental output from the current LLM turn.
 *
 * Discriminated on `kind`:
 *   - `text` / `thinking`: streamed prose / reasoning, carries `text`.
 *   - `tool-use`: model emitted a tool call with structured `input`.
 *   - `tool-result`: tool finished and produced `output` (or an error).
 *
 * The host's chat:stream-chunk subscribers fan these out to clients verbatim;
 * the wire is opaque about how each variant should be rendered. Field names
 * are LLM-API vocabulary (Anthropic's tool_use/tool_result), not transport
 * vocabulary — boundary review I1.
 */
export const EventStreamChunkSchema = z.discriminatedUnion('kind', [
  z.object({
    reqId: z.string(),
    kind: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    reqId: z.string(),
    kind: z.literal('thinking'),
    text: z.string(),
  }),
  z.object({
    reqId: z.string(),
    kind: z.literal('tool-use'),
    /** Matches Anthropic ToolUseBlock.id; round-trips with tool-result.toolCallId. */
    toolCallId: z.string(),
    toolName: z.string(),
    /** Raw input the model produced for this tool call. */
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    reqId: z.string(),
    kind: z.literal('tool-result'),
    toolCallId: z.string(),
    /** Stringified result. Tools producing rich content (images) flatten to
     *  text on the wire; full structure persists at turn-end. */
    output: z.string(),
    isError: z.boolean().optional(),
  }),
]);
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
  /** Stable identifier for the turn the runner just emitted, used by
   * subscribers (e.g., @ax/routines silence-token logic) that need to
   * refer back to this specific turn — usually the jsonl line's uuid
   * for the assistant turn this event closes. Optional until producers
   * adopt it (see @ax/agent-claude-sdk-runner Phase 2 task). */
  turnId: z.string().optional(),
});
export type EventTurnEnd = z.infer<typeof EventTurnEndSchema>;

/**
 * Terminal outcome of a chat, mirroring `@ax/core/src/types.ts` `AgentOutcome`
 * but declared locally to keep this package independent of the kernel.
 */
export const AgentOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('complete'),
    messages: z.array(AgentMessageSchema),
  }),
  z.object({
    kind: z.literal('terminated'),
    reason: z.string(),
    error: z.unknown().optional(),
  }),
]);
export type AgentOutcome = z.infer<typeof AgentOutcomeSchema>;

export const EventChatEndSchema = z.object({
  outcome: AgentOutcomeSchema,
});
export type EventChatEnd = z.infer<typeof EventChatEndSchema>;
