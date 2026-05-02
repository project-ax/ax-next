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

export const AgentMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

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
// Bundle-bytes wire validator (shared between commit-notify + materialize).
//
// Both wire shapes carry git bundle bytes as base64 strings. We validate
// the base64 shape at the protocol boundary so malformed payloads
// surface as a 400 VALIDATION error here rather than as an INTERNAL 500
// later in `git fetch` / `Buffer.from(..., 'base64')`. The empty string
// is allowed (means "no bundle this turn" on commit-notify; materialize
// always returns non-empty in practice).
//
// Pattern: standard base64 alphabet (A-Z, a-z, 0-9, +, /), length is a
// multiple of 4, and `=` padding only at the tail. The regex matches
// the canonical shape; Buffer.from(s, 'base64') is permissive (it
// silently ignores garbage), so we don't lean on it for validation.
// ---------------------------------------------------------------------------

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BundleBytesSchema = z
  .string()
  .refine((s) => s === '' || BASE64_RE.test(s), {
    message: 'bundleBytes must be empty or canonical base64',
  });

// ---------------------------------------------------------------------------
// workspace.commit-notify
//
// Phase 3 (this PR): the runner ships per-turn diffs as a `git bundle` of
// commits authored by `ax-runner`, base64-encoded as `bundleBytes`. The
// host unpacks the bundle, verifies provenance, and translates to a
// canonical `WorkspaceChange[]` BEFORE firing any bus hook. The wire field
// `bundleBytes` is git-vocabulary, but per Invariant I1 that's allowed
// here — same justification as `workspace.materialize`:
//   1. This is the sandbox-host transport axis; no `workspace:*` bus hook
//      ever sees the bundle bytes.
//   2. Host bundler (Slice 6) decodes the bundle into backend-agnostic
//      `WorkspaceChange[]` before the first subscriber visibility.
//
// `parentVersion` is opaque (`workspace:apply` returns it; the runner round-
// trips it). `reason` is a free-text label for the commit ("turn", or a
// future user-supplied tag); it surfaces as the `reason` field on the
// `workspace:pre-apply` payload so subscribers can shape their decision.
//
// Empty bundle: a turn that wrote nothing. `bundleBytes === ''` short-
// circuits the handler (no apply, returns `accepted: true` against the
// existing parentVersion). Preserved as a no-op rather than a hard error
// because some turn boundaries genuinely write nothing (e.g., the model
// answered without touching files).
// ---------------------------------------------------------------------------

export const WorkspaceCommitNotifyRequestSchema = z.object({
  parentVersion: z.string().nullable(),
  reason: z.string(),
  // base64-encoded git bundle bytes from the runner's
  // `git bundle create - baseline..HEAD`. Empty string => no commits this
  // turn (handler short-circuits; no apply called).
  bundleBytes: BundleBytesSchema,
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
// workspace.materialize
//
// Sandbox -> Host RPC fired EXACTLY ONCE at session start, before the SDK's
// query loop opens. The host produces a `git bundle` over the workspace's
// current state (or empty bytes when the workspace is brand-new) and returns
// it base64-encoded. The sandbox-side runner unpacks into `/permanent` so
// the agent runs against a real git working tree from turn 1.
//
// `bundleBytes` is git-vocabulary on the wire — by Invariant I1 that's
// allowed here because:
//   1. This is the sandbox-host transport axis, not a subscriber-visible
//      hook payload. No `workspace:*` bus hook ever sees the bundle bytes.
//   2. The host bundler decodes the bundle into backend-agnostic
//      `WorkspaceChange[]` before any subscriber visibility on the OUTBOUND
//      direction (commit-notify); on the INBOUND direction (materialize)
//      the bytes never leave the sandbox-host wire — they go straight into
//      `git clone` on the runner side.
//   3. The same justification is mirrored on `workspace.commit-notify`'s
//      `bundleBytes` (Phase 3 wire change).
//
// Empty workspace handling: even a brand-new workspace gets a bundle
// with one commit (the deterministic empty-tree baseline). The runner
// always clones; there's no `git init` shortcut. Symmetric on both
// sides — see `buildBaselineBundle` in the materialize handler.
// ---------------------------------------------------------------------------

// `.strict()` — the request takes no parameters today. The bearer token
// already identifies the session, and the action is implicitly scoped to
// the session's workspace. Stuffing unknown fields here is a bug.
export const WorkspaceMaterializeRequestSchema = z.object({}).strict();
export type WorkspaceMaterializeRequest = z.infer<
  typeof WorkspaceMaterializeRequestSchema
>;

export const WorkspaceMaterializeResponseSchema = z.object({
  // base64-encoded git bundle bytes. Always non-empty — even an empty
  // workspace ships a single empty-tree baseline commit so the runner
  // has a valid `refs/heads/baseline` to bundle from on subsequent
  // turns. (Validated as canonical base64 — empty allowed by the
  // shared schema, but materialize never returns empty in practice.)
  bundleBytes: BundleBytesSchema,
});
export type WorkspaceMaterializeResponse = z.infer<
  typeof WorkspaceMaterializeResponseSchema
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
//   - Phase C (2026-05-02): `runnerSessionId` is the bound runner-side
//     session id, or `null` if no runner has ever bound one. Runners
//     branch on `runnerSessionId !== null` to choose SDK
//     `resume(sessionId)` vs replay-from-DB. Wire name is camelCase,
//     opaque, never the snake_case `runner_session_id` from the DB row.
//     Trade-off: the host still loads `turns` from the DB even when the
//     runner is going to ignore them on a resume — the extra read is
//     cheap (one query at runner boot) and keeps the wire shape simple.
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
  // Phase C: nullable, NEVER `undefined`. Explicit null keeps the wire
  // shape stable and forces consumers to branch on three states (string,
  // null, or schema-fail) rather than treat absent as "no opinion".
  runnerSessionId: z.string().nullable(),
});
export type ConversationFetchHistoryResponse = z.infer<
  typeof ConversationFetchHistoryResponseSchema
>;

// ---------------------------------------------------------------------------
// conversation.store-runner-session
//
// Runner → host RPC fired ONCE per session, the first time the SDK emits a
// `system/init` message that carries a session_id. The runner forwards that
// id so the host can persist it on the conversation row; on the next boot
// the runner reads it back via `session.get-config` (or a sibling field) and
// calls `query({ resume: sessionId })` instead of replaying the transcript
// turn-by-turn. That swap is the whole point of Phase C — the SDK already
// owns durable transcripts on disk under `~/.claude/projects/<sessionId>`,
// and replaying our DB version on top of that is just expensive and racy.
//
// Authz on the host: the bus-side `conversations:store-runner-session` hook
// runs a `ctx.userId`-scoped UPDATE only — it does NOT call `agents:resolve`
// (Phase B's posture; see `packages/conversations/src/plugin.ts:234-238`).
// The runner authenticates IPC via its session bearer token, the IPC server
// resolves the token to ctx.userId, and that userId is what reaches the
// UPDATE — same trust pivot as `conversation.fetch-history`.
//
// Field-name conventions (I1):
//   - `runnerSessionId` is generic. SDKs other than Anthropic's also mint a
//     resumable session identifier; we just hold the string and hand it
//     back unchanged. No claude-sdk vocabulary leaks.
// ---------------------------------------------------------------------------

export const ConversationStoreRunnerSessionRequestSchema = z
  .object({
    conversationId: z.string().min(1).max(256),
    runnerSessionId: z.string().min(1).max(256),
  })
  .strict();
export type ConversationStoreRunnerSessionRequest = z.infer<
  typeof ConversationStoreRunnerSessionRequestSchema
>;

export const ConversationStoreRunnerSessionResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict();
export type ConversationStoreRunnerSessionResponse = z.infer<
  typeof ConversationStoreRunnerSessionResponseSchema
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
    payload: AgentMessageSchema,
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
