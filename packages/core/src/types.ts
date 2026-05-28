import type { Rejection } from './errors.js';

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Phase 2 (attachments). Optional richer payload — when present the
   * runner prefers this over `content`. Mirrors the wire shape in
   * `@ax/ipc-protocol`'s `AgentMessageSchema`. Kept as `unknown[]` here
   * (rather than importing `ContentBlock` from `@ax/ipc-protocol`) to
   * keep `@ax/core` free of wire-layer imports; consumers that need the
   * narrow shape can re-cast or import from the protocol layer.
   */
  contentBlocks?: unknown[];
  /**
   * Phase 3 (attachments, 2026-05-18). Server-minted user-turn id; see
   * the equivalent comment on `@ax/ipc-protocol`'s `AgentMessageSchema`
   * for the binding rationale.
   */
  turnId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  output: unknown;
  isError?: boolean;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  // JSON Schema for the tool's input. Required so LLM providers can forward
  // the shape to the model. Kept as an opaque object so plugins can emit any
  // valid JSON Schema draft without coupling to a specific zod version.
  inputSchema: Record<string, unknown>;
  /**
   * Where the tool physically runs:
   * - `'sandbox'`: the agent runtime dispatches locally, never hits the host.
   * - `'host'`: the agent sends `tool.execute-host` and waits for the host.
   *
   * Must match the corresponding field on `@ax/ipc-protocol`'s
   * `ToolDescriptorSchema` — see that file for the cross-boundary shape.
   */
  executesIn: 'sandbox' | 'host';
  /**
   * When `true`, the agent runtime MUST flush its live workspace (commit +
   * push to the host's workspace mirror) BEFORE forwarding this host tool's
   * `tool.execute-host` call.
   *
   * Only meaningful for `executesIn: 'host'` tools that read workspace files
   * the agent may have written earlier in the SAME turn. Under runner-owned
   * sessions the host only sees the committed+pushed workspace mirror, which
   * lags the runner's live tree until a turn-boundary commit — so without the
   * flush a host tool reading e.g. `.ax/skills/<id>/SKILL.md` would not yet
   * see a file the agent just authored. Declarative on purpose: the tool
   * states its need; the runtime owns the flush mechanism.
   *
   * Must match the corresponding field on `@ax/ipc-protocol`'s
   * `ToolDescriptorSchema`.
   */
  flushWorkspaceBeforeCall?: boolean;
}

export type AgentOutcome =
  | { kind: 'complete'; messages: AgentMessage[] }
  | { kind: 'terminated'; reason: string; error?: unknown };

export type FireResult<P> =
  | { rejected: false; payload: P }
  | Rejection;

/**
 * Canonical input to the `llm:call` service hook.
 *
 * Provider-agnostic. The registrar plugin (e.g. `@ax/llm-anthropic`) is
 * responsible for translating to its SDK's request shape. Optional fields
 * fall back to plugin-level defaults — callers that don't care about model
 * selection or output cap can pass just `messages`.
 *
 * Shape biases — acknowledged and deferred:
 *  - `system` is a top-level field (Anthropic-shape). An OpenAI-style
 *    registrar must coalesce this into a `messages[0]` with role `'system'`.
 *  - `messages.role` is `'user' | 'assistant'` only — system is the
 *    top-level field above, not an entry in `messages`.
 *  - `messages.content` is `string` — multimodal blocks (`ContentBlock[]`)
 *    are deferred. No tool-use, streaming, or citations either.
 *
 * If a second registrar (OpenAI, local model) lands and these biases bite,
 * the right fix is to widen the canonical shape — accept `'system'` in
 * `messages.role`, drop the top-level `system` — before a third registrar
 * shows up. Phase F is the only consumer today, so the cost of changing
 * later is bounded.
 */
export interface LlmCallInput {
  model?: string;
  maxTokens?: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
}

/**
 * Canonical output from `llm:call`. The model's response text and the
 * structural fields the orchestrator needs to decide what to do next.
 *
 * `stopReason` is normalized to a small known set; provider-specific values
 * (e.g. `pause_turn`, `refusal`) collapse to `'unknown'` so subscribers can
 * key off the union exhaustively without per-provider branches.
 */
export interface LlmCallOutput {
  text: string;
  stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'unknown';
  usage: { inputTokens: number; outputTokens: number };
}
