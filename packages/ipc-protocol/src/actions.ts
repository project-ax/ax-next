import { z } from 'zod';
import { asWorkspaceVersion, type WorkspaceVersion } from '@ax/core';
import { ContentBlockSchema } from './content-blocks.js';

// Re-export so existing consumers importing from `@ax/ipc-protocol` keep
// working transparently — canonical declaration lives in `@ax/core` so
// nothing is tempted to reach into a workspace backend for the shared type.
export { asWorkspaceVersion, type WorkspaceVersion };

// ---------------------------------------------------------------------------
// Shared shapes
//
// These are deliberately redeclared here rather than imported from @ax/core.
// @ax/ipc-protocol is the wire layer; host-side plugins and the sandbox-side
// runner both depend on it, and the sandbox side must not pull in the kernel.
// If these shapes drift from @ax/core/src/types.ts, that's a signal to
// reconcile — the boundary is intentional, not accidental.
// ---------------------------------------------------------------------------

export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * Tool-specific input. Opaque at the protocol layer — each tool defines
   * its own inputSchema (JSON Schema). Validating here would couple the
   * wire protocol to every tool's shape.
   */
  input: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /**
   * JSON Schema for the tool's input. Kept as an opaque object so plugins
   * can emit any valid JSON Schema draft without coupling the protocol
   * to a specific zod version.
   */
  inputSchema: z.record(z.unknown()),
  /**
   * Where the tool physically runs:
   * - `'sandbox'`: the agent runtime dispatches locally, never hits the host.
   * - `'host'`: the agent sends `tool.execute-host` and waits for the host.
   */
  executesIn: z.enum(['sandbox', 'host']),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

// ---------------------------------------------------------------------------
// llm.call
//
// Request/response envelopes are NOT `.strict()`: model-provider plugins
// will grow new optional knobs (reasoning depth, stop sequences, etc.),
// and rejecting unknown fields would make rolling adds across host and
// sandbox painful. `.strict()` is reserved for envelopes where every key
// must be load-bearing (see errors.ts).
// ---------------------------------------------------------------------------

export const LlmCallRequestSchema = z.object({
  messages: z.array(ChatMessageSchema),
  tools: z.array(ToolDescriptorSchema).optional(),
  model: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
});
export type LlmCallRequest = z.infer<typeof LlmCallRequestSchema>;

export const LlmCallResponseSchema = z.object({
  assistantMessage: ChatMessageSchema,
  toolCalls: z.array(ToolCallSchema),
  stopReason: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type LlmCallResponse = z.infer<typeof LlmCallResponseSchema>;

// ---------------------------------------------------------------------------
// tool.pre-call
// ---------------------------------------------------------------------------

export const ToolPreCallRequestSchema = z.object({
  call: ToolCallSchema,
});
export type ToolPreCallRequest = z.infer<typeof ToolPreCallRequestSchema>;

export const ToolPreCallResponseSchema = z.discriminatedUnion('verdict', [
  z.object({
    verdict: z.literal('allow'),
    modifiedCall: ToolCallSchema.optional(),
  }),
  z.object({
    verdict: z.literal('reject'),
    reason: z.string(),
  }),
]);
export type ToolPreCallResponse = z.infer<typeof ToolPreCallResponseSchema>;

// ---------------------------------------------------------------------------
// tool.execute-host
//
// Schema only — no runtime wiring in 6.5a. The sandbox sends this when a
// ToolDescriptor declares `executesIn: 'host'`.
// ---------------------------------------------------------------------------

export const ToolExecuteHostRequestSchema = z.object({
  call: ToolCallSchema,
});
export type ToolExecuteHostRequest = z.infer<typeof ToolExecuteHostRequestSchema>;

export const ToolExecuteHostResponseSchema = z.object({
  /** Tool-specific output shape — opaque at the protocol layer. */
  output: z.unknown(),
});
export type ToolExecuteHostResponse = z.infer<typeof ToolExecuteHostResponseSchema>;

// ---------------------------------------------------------------------------
// tool.list
// ---------------------------------------------------------------------------

// `.strict()` because tool.list takes no parameters today and stuffing
// unknown fields into the request body is almost certainly a protocol
// misuse — better to fail loudly than to silently drop them.
export const ToolListRequestSchema = z.object({}).strict();
export type ToolListRequest = z.infer<typeof ToolListRequestSchema>;

export const ToolListResponseSchema = z.object({
  tools: z.array(ToolDescriptorSchema),
});
export type ToolListResponse = z.infer<typeof ToolListResponseSchema>;

// ---------------------------------------------------------------------------
// workspace.commit-notify
//
// Invariant I4: field names must not leak one backend's vocabulary.
// - `parentVersion` / `version` instead of `parentSha` / `sha` (git-ism)
// - `commitRef` is the generic handle — not "blobId", not "objectId"
// - `delta` is null for now; schema leaves room for a future wire shape
//   without forcing one backend's diff format into the protocol.
//
// `changes` is the runner's per-turn diff against `parentVersion`. The wire
// is JSON, so binary file content is base64-encoded in transit and the Zod
// transform decodes to `Uint8Array` so the parsed shape matches `@ax/core`'s
// `FileChange` directly. Encoding is the runner's responsibility (see Task
// 7c). `commitRef` is an opaque runner-side identifier; the host doesn't
// dispatch on it — the `changes` array IS the source of truth.
// ---------------------------------------------------------------------------

/**
 * Wire mirror of `@ax/core.FileChange`. The canonical type lives in
 * `@ax/core`; this schema parses the JSON-on-the-wire encoding (base64 for
 * `put.content`) and transforms it to bytes so the parsed value is
 * shape-compatible with the kernel type.
 */
export const FileChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    path: z.string(),
    kind: z.literal('put'),
    // Bytes ride the wire as base64 strings (JSON can't carry Uint8Array).
    // Transform to bytes so consumers see `@ax/core.FileChange`-shaped data.
    content: z.string().transform((b64) => new Uint8Array(Buffer.from(b64, 'base64'))),
  }),
  z.object({
    path: z.string(),
    kind: z.literal('delete'),
  }),
]);
export type WireFileChange = z.infer<typeof FileChangeSchema>;

export const WorkspaceCommitNotifyRequestSchema = z.object({
  parentVersion: z.string().nullable(),
  commitRef: z.string(),
  message: z.string(),
  // Backwards-compat default: pre-Task-7c runners that don't yet send
  // `changes` continue to round-trip as an empty diff (no-op apply).
  changes: z.array(FileChangeSchema).default([]),
});
export type WorkspaceCommitNotifyRequest = z.infer<
  typeof WorkspaceCommitNotifyRequestSchema
>;

export const WorkspaceCommitNotifyResponseSchema = z.discriminatedUnion(
  'accepted',
  [
    z.object({
      accepted: z.literal(true),
      // Brand the parsed wire value so consumers pick up the opaque-token
      // contract automatically — no cast needed, and the type system
      // catches accidental `.startsWith('sha')`-style backend sniffing.
      version: z.string().transform((v) => v as WorkspaceVersion),
      delta: z.null(),
    }),
    z.object({
      accepted: z.literal(false),
      reason: z.string(),
    }),
  ],
);
export type WorkspaceCommitNotifyResponse = z.infer<
  typeof WorkspaceCommitNotifyResponseSchema
>;

// ---------------------------------------------------------------------------
// session.get-config
//
// Runner → host RPC fetched at boot. Authentication is the bearer token
// the runner already holds (set in its env by sandbox:open-session); the
// host's IPC server resolves the token to a sessionId and stamps that on
// ctx.sessionId before dispatch — this action's request body is therefore
// EMPTY by design. A non-empty body would mean the runner could ask for
// SOMEONE ELSE'S config; closing that door at the schema layer makes the
// invariant load-bearing.
//
// The response carries the FROZEN agent config snapshot (per Invariant
// I10 — switching agents = new session, not mutate). systemPrompt is
// USER-AUTHORED and intended to flow into the LLM's prompt; the runner
// must NOT interpolate it into shell commands, file paths, or HTML. We
// brand the field at the consumer side rather than here so subscriber
// hooks downstream of the runner don't need a wire-level brand.
// ---------------------------------------------------------------------------

export const SessionGetConfigRequestSchema = z.object({}).strict();
export type SessionGetConfigRequest = z.infer<typeof SessionGetConfigRequestSchema>;

export const AgentConfigSchema = z.object({
  systemPrompt: z.string(),
  allowedTools: z.array(z.string()),
  mcpConfigIds: z.array(z.string()),
  model: z.string(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const SessionGetConfigResponseSchema = z.object({
  userId: z.string(),
  agentId: z.string(),
  agentConfig: AgentConfigSchema,
  /**
   * Conversation this session is bound to, when one exists. Nullable
   * because not every session is conversation-scoped (canary acceptance
   * tests, ephemeral admin probes, pre-Task-15 sessions). The runner uses
   * this to decide whether to call `conversation.fetch-history` at boot.
   *
   * The host populates this from the session row (Task 15 added a
   * `conversation_id` column to the session backend; the orchestrator
   * sets it at session-creation time). NEVER `undefined` — explicit null
   * keeps the wire shape stable across the schema bump (an absent field
   * would force every consumer to branch on three states).
   */
  conversationId: z.string().nullable(),
});
export type SessionGetConfigResponse = z.infer<typeof SessionGetConfigResponseSchema>;

// ---------------------------------------------------------------------------
// conversation.fetch-history
//
// Runner → host RPC fetched at boot AFTER `session.get-config` returns a
// non-null conversationId. Returns the persisted turn-by-turn transcript
// so the runner can replay user-side history into the SDK's prompt
// iterator before processing live inbox messages (J3 + J6 resume).
//
// Authz on the host: the bus-side `conversations:fetch-history` hook calls
// `conversations:get(conversationId, ctx.userId)` — that gate already
// enforces user ownership AND `agents:resolve`, so a runner that forges a
// foreign conversationId still can't read it. The runner authenticates
// IPC via its session bearer token; the IPC server resolves the token
// to ctx.userId, and that userId is what reaches `conversations:get`.
//
// Field-name conventions (I1):
//   - `turns` is generic. Each entry is `{ role, contentBlocks }` — same
//     shape Anthropic / OpenAI / Gemini wrappers translate into. No
//     storage-backend vocabulary leaks.
//   - We deliberately do NOT include turnId / createdAt / turnIndex on
//     the wire shape. The runner replays into the SDK; ordering is
//     implicit in the array order, and identity is the LLM's concern,
//     not ours. A future audit/debug consumer that wants those fields
//     should call `conversations:get` directly (host-side hook).
// ---------------------------------------------------------------------------

export const ConversationFetchHistoryRequestSchema = z.object({
  conversationId: z.string().min(1).max(256),
}).strict();
export type ConversationFetchHistoryRequest = z.infer<
  typeof ConversationFetchHistoryRequestSchema
>;

export const ConversationFetchHistoryTurnSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  contentBlocks: z.array(ContentBlockSchema),
});
export type ConversationFetchHistoryTurn = z.infer<
  typeof ConversationFetchHistoryTurnSchema
>;

export const ConversationFetchHistoryResponseSchema = z.object({
  turns: z.array(ConversationFetchHistoryTurnSchema),
});
export type ConversationFetchHistoryResponse = z.infer<
  typeof ConversationFetchHistoryResponseSchema
>;

// ---------------------------------------------------------------------------
// session.next-message
//
// The request is an HTTP GET with a `?cursor=<n>` query-string parameter;
// it is NOT Zod-validated at the protocol layer. The server-side parsing
// of that query string is the IPC server's responsibility.
//
// Only the response body is protocol-level — the three variants are what
// the sandbox inbox loop branches on.
//
// Cursor semantics: the response `cursor` is the NEXT cursor the client
// should request. On `user-message` / `cancel` it's the index of the
// delivered entry + 1; on `timeout` it's the cursor the client sent
// (echo — no entry was delivered, so no advancement). The sandbox inbox
// loop stores this value verbatim and passes it back on the next GET.
// ---------------------------------------------------------------------------

// `reqId` on `user-message` is the server-minted request identifier (J9)
// that the host stamped onto the message when it called
// `session:queue-work`. The runner caches it locally and uses it to label
// every `event.stream-chunk` it emits while processing this user message,
// so the host's chat:stream-chunk subscriber can route chunks back to the
// correct waiting client (Task 5/7). REQUIRED — every user message that
// reaches a runner originated from a host request, and that request had a
// reqId before it entered the inbox; allowing it to be missing would let a
// stream chunk emit with no correlation handle, which the host can't route.
export const SessionNextMessageResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user-message'),
    payload: ChatMessageSchema,
    reqId: z.string(),
    cursor: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('cancel'),
    cursor: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('timeout'),
    cursor: z.number().int().nonnegative(),
  }),
]);
export type SessionNextMessageResponse = z.infer<
  typeof SessionNextMessageResponseSchema
>;
