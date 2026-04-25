import { z } from 'zod';
import { asWorkspaceVersion, type WorkspaceVersion } from '@ax/core';

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

export const SessionNextMessageResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user-message'),
    payload: ChatMessageSchema,
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
