import { z } from 'zod';
import { AgentMessageSchema, ToolCallSchema } from './actions.js';
import { ContentBlockSchema } from './content-blocks.js';
import { SaveRefusedCodeSchema } from './save-refused.js';

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
    /**
     * Host-authored activity label (TASK-271) — the live-chunk twin of
     * `ToolUseBlock.activityPhrase`. Same optionality and fencing contract.
     */
    activityPhrase: z.string().optional(),
  }),
  z.object({
    reqId: z.string(),
    kind: z.literal('tool-result'),
    toolCallId: z.string(),
    /** Stringified result. Tools producing rich content (images) flatten to
     *  text on the wire; full structure persists at turn-end. */
    output: z.string(),
    isError: z.boolean().optional(),
    /**
     * Live-chunk twin of `ToolResultBlock.held` (TASK-270): the call never
     * ran and is waiting on a human. Same optionality; readers stash it in
     * the toolCallId-keyed display map, never in the part (the assistant-ui
     * bridge rebuilds tool-call parts lossily).
     */
    held: z.boolean().optional(),
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
 * Upper bound on any one reported token count. Runner data is untrusted; a
 * billion tokens is far beyond any real turn (context windows are ~1e6), so
 * this only ever rejects garbage, never a legitimate report.
 */
const TokenCountSchema = z.number().int().nonnegative().max(1_000_000_000);

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
// SaveRefusedCodeSchema (TASK-720/731) lives in ./save-refused.js: the
// `conversation.drain-save-refusals` action (TASK-749) shares it, and
// actions.ts cannot import this module (this module imports it).

export const EventTurnEndSchema = z.object({
  reqId: z.string().optional(),
  reason: z.enum(['user-message-wait', 'error', 'complete']),
  /**
   * What the turn cost (TASK-692, per-user spend limits). Runner-reported and
   * therefore UNTRUSTED: every count is a bounded nonnegative integer, and the
   * host stamps WHOSE usage it is from its own session record, never from this
   * payload. Only the ASSISTANT turn-end carries it (not the role='tool' one).
   *
   * Field semantics (the host's price table depends on them; do not blur them):
   *   - `model`: the `provider/model-id` ref the turn ran on (the agent's
   *     configured model, e.g. `anthropic/claude-sonnet-4-6`).
   *   - `inputTokens`: input tokens billed at the STANDARD input rate, i.e.
   *     EXCLUDING cache reads and cache writes.
   *   - `outputTokens`: all output tokens, including reasoning/thinking.
   *   - `cacheReadTokens` / `cacheWriteTokens`: cached-input tokens read /
   *     written (billed at their own rates).
   *
   * Absent `usage` means "this runner could not tell"; the host then charges a
   * conservative flat assumed cost (unknown is never free). Unknown keys inside
   * the object are stripped (zod's object default), never passed through.
   */
  usage: z
    .object({
      model: z.string().min(1).max(200).optional(),
      inputTokens: TokenCountSchema.optional(),
      outputTokens: TokenCountSchema.optional(),
      cacheReadTokens: TokenCountSchema.optional(),
      cacheWriteTokens: TokenCountSchema.optional(),
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
   * adopt it (see @ax/agent-claude-sdk-runner Phase 2 task). Empty
   * strings are rejected so a misbehaving producer can't trip the
   * downstream "drop most recent turn" fallback. */
  turnId: z.string().min(1).optional(),
  /**
   * The host refused this turn's end-of-turn workspace save, so the runner
   * undid the turn's file changes (TASK-720). Before this field the refusal
   * was silent to the person: the refusal's own reason is prose written for
   * the model, and the model's turn is already over when the save runs.
   *
   * A closed code (see SaveRefusedCodeSchema), never prose. The host also
   * persists it as a `save-refused` display event, so the notice survives a
   * reload (TASK-731).
   * Absent means the save went through, had nothing to save, or failed in a
   * way the runner keeps and retries next turn.
   */
  saveRefused: SaveRefusedCodeSchema.optional(),
  /**
   * The reqIds of OTHER user messages this turn answered (TASK-708). A runner
   * whose model folds a message that arrived mid-turn into the running turn
   * (the Claude Code CLI does, at a tool boundary) produces ONE turn for two
   * `chat:start`s; the folded message never gets a turn-end of its own, so
   * without this a per-turn subscriber keeps waiting on it until `chat:end`.
   *
   * Only ids the runner OBSERVED being consumed into this turn — never a guess
   * from counting messages — and never the turn's own `reqId`. Runner-reported
   * and therefore untrusted: bounded, and a subscriber may only use it to stop
   * waiting on an id it was already waiting on.
   */
  foldedReqIds: z.array(z.string().min(1).max(256)).max(64).optional(),
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
  /**
   * The host refused the runner's FINAL/idle save, the flush after the last
   * turn-end (TASK-731). That flush bundles everything since the baseline, so
   * it can carry files from earlier replies whose own save came back `kept`
   * (host unreachable), plus late/background writes: files the person may
   * have watched being made. There is no turn-end left to carry the code and
   * no stream is open, so it rides here and the host persists it as a
   * `save-refused` display event for the next read of the thread.
   * Same closed code set as `EventTurnEnd.saveRefused`. Absent means the
   * final save went through, had nothing to save, or never ran.
   */
  saveRefused: SaveRefusedCodeSchema.optional(),
});
export type EventChatEnd = z.infer<typeof EventChatEndSchema>;
