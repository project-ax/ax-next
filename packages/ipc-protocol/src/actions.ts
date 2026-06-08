import { z } from 'zod';
import { asWorkspaceVersion, type WorkspaceVersion } from '@ax/core';
import { ContentBlockSchema, isWorkspaceRelativePath } from './content-blocks.js';

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
  // Phase 2 (attachments). Optional richer payload — when present, the
  // runner prefers this over `content`. The chat-messages handler does
  // not emit this yet (Phase 3); shipping the schema first lets the
  // runner translation pass be testable. Backward-compat: omitting the
  // field reproduces the prior string-only shape exactly.
  contentBlocks: z.array(ContentBlockSchema).optional(),
  /**
   * Phase 3 (attachments, 2026-05-18). Server-minted user-turn id, used
   * by the runner to bind the user message to the same turn the host
   * committed attachments under. The chat-messages handler mints this
   * BEFORE calling `attachments:commit` so the committed file path
   * (`.ax/uploads/<conversationId>/<turnId>/<file>`) and the SDK turn
   * that references it agree. Optional for backward-compat with code
   * paths that don't carry attachments (existing canary tests).
   */
  turnId: z.string().optional(),
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
  /**
   * When `true`, the runner flushes its live workspace (commit + push to the
   * host mirror) before forwarding this host tool's `tool.execute-host` call,
   * so a host tool that reads workspace files the agent wrote earlier in the
   * SAME turn sees them. See `@ax/core`'s `ToolDescriptor` for the rationale.
   * Storage-agnostic: "workspace" is the abstraction, not git/sqlite/k8s.
   */
  flushWorkspaceBeforeCall: z.boolean().optional(),
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
      // Re-sync signal (optional; present only on a parent-mismatch rejection):
      // the storage tier's current head. When set, the runner fetches the
      // baseline bundle AT this head out-of-band via the binary
      // `workspace.export-baseline-bundle` action (octet-stream, uncapped),
      // rebases its turn onto it, and retries. Opaque to the runner.
      //
      // The baseline bundle is NO LONGER inlined here (BUG: same class as the
      // materialize BUG-W3). An aged workspace's baseline bundle (~MiB) base64-
      // encoded into this JSON body exceeded the runner ipc-client's 4 MiB
      // MAX_RESPONSE_BYTES cap → `response body too large` → the turn never
      // synced → 120 s agent:invoke timeout → terminate → unknown-token loop.
      // The bytes now stream over `workspace.export-baseline-bundle` (the
      // uncapped binary path) instead of riding in this JSON response.
      actualParent: z.string().optional(),
      // Phase 2: whether the agent's working tree should be PRESERVED on rollback.
      // Absent ⟹ recoverable (runner uses `git reset --mixed`, keeping the
      // agent's files). `false` ⟹ a hard security veto (SDK-config write,
      // tampered bundle) the runner clears with `git reset --hard` so it can't
      // wedge the atomic transcript bundle. A semantic, not backend vocabulary.
      recoverable: z.boolean().optional(),
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
// current state (or a deterministic empty-tree baseline when the workspace
// is brand-new) and streams the RAW bundle bytes back as the HTTP response
// body — `Content-Type: application/octet-stream`, NOT a JSON envelope. The
// sandbox-side runner drains the body straight to a temp file and clones
// `/agent` from it, so the agent runs against a real git working tree
// from turn 1.
//
// Why a raw binary body (BUG-W3): the bundle is the one IPC payload whose
// size grows unbounded with workspace age (every turn adds a commit). The
// old shape base64-encoded it into a JSON field, which (a) inflated it ~33%
// and (b) had to be buffered whole in memory on both ends under the 4 MiB
// `MAX_RESPONSE_BYTES` cap. A workspace with ~143 files + many turn commits
// blew that cap and the runner crashed on boot (`response body too large`).
// Streaming the raw bytes drops the base64 tax and the in-memory cap wall —
// the runner drains to disk under a much higher, disk-bounded ceiling. The
// per-turn `commit-notify` bundle stays JSON+base64 (it's bounded per turn).
//
// `git bundle` is git-vocabulary on the wire — by Invariant I1 that's
// allowed here because this is the sandbox-host transport axis, not a
// subscriber-visible hook payload. No `workspace:*` bus hook ever sees the
// bundle bytes; on this INBOUND direction they never leave the sandbox-host
// wire — they go straight into `git clone` on the runner side. (The OUTBOUND
// `commit-notify` direction is decoded into backend-agnostic
// `WorkspaceChange[]` before any subscriber visibility.)
//
// Empty workspace handling: even a brand-new workspace gets a bundle with
// one commit (the deterministic empty-tree baseline). The runner always
// clones; there's no `git init` shortcut. Symmetric on both sides — see
// `buildBaselineBundle` in the materialize handler.
//
// No response SCHEMA: the body is opaque binary, so there's no Zod-parsed
// JSON response here (cf. the dispatch table in `ipc-client.ts`). The
// request stays JSON ({}), validated below.
// ---------------------------------------------------------------------------

// `.strict()` — the request takes no parameters today. The bearer token
// already identifies the session, and the action is implicitly scoped to
// the session's workspace. Stuffing unknown fields here is a bug.
export const WorkspaceMaterializeRequestSchema = z.object({}).strict();
export type WorkspaceMaterializeRequest = z.infer<
  typeof WorkspaceMaterializeRequestSchema
>;

// ---------------------------------------------------------------------------
// workspace.export-baseline-bundle
//
// Sandbox -> Host RPC fired ON THE COMMIT-NOTIFY RE-SYNC PATH only. When a
// concurrent writer advanced the workspace head past the runner's parent
// version, `workspace.commit-notify` returns `{accepted:false, actualParent}`
// (a small JSON signal — NO bundle bytes). The runner then calls THIS action
// with `{ version: actualParent }` to fetch the baseline git bundle AT that
// head, rebases its turn onto it, and retries the commit-notify.
//
// Why a raw binary body (same bug class as materialize's BUG-W3): the baseline
// bundle grows unbounded with workspace age (one commit per turn). Inlining it
// base64-in-JSON in the commit-notify re-sync response (the OLD shape) inflated
// it ~33% AND had to be buffered whole in memory on both ends under the 4 MiB
// `MAX_RESPONSE_BYTES` cap. An aged workspace blew the cap, the re-sync never
// completed, the turn timed out, and the session entered an unknown-token loop.
// Streaming the raw bytes here (`Content-Type: application/octet-stream`, drained
// straight to a temp file) drops the base64 tax and the in-memory cap wall — the
// runner clones/fetches from the file under the same disk-bounded ceiling
// materialize uses.
//
// `git bundle` is git-vocabulary on the wire — by Invariant I1 that's allowed
// here for the same reason as materialize: this is the sandbox-host transport
// axis, not a subscriber-visible hook payload. No `workspace:*` bus hook ever
// sees these bundle bytes; on this INBOUND direction they go straight into the
// runner's `git fetch` for the rebase. The host produces them by calling the
// existing `workspace:export-baseline-bundle` SERVICE hook (registered by the
// bundle-aware backends) and decoding its base64 output at this wire edge.
//
// No response SCHEMA: the body is opaque binary, so there's no Zod-parsed JSON
// response (cf. the dispatch table in `ipc-client.ts`, which omits this action
// alongside materialize). The REQUEST stays JSON, validated below.
//
// `version` is the opaque workspace head the runner must rebase onto — it's the
// `actualParent` it received from the commit-notify re-sync signal. It's a
// REQUIRED string here: the re-sync path always has a concrete head to fetch
// (a `null` version would be the materialize path, which has its own action).
// ---------------------------------------------------------------------------

export const WorkspaceExportBaselineBundleRequestSchema = z
  .object({
    // The storage-tier head to bundle. Opaque to the runner — it round-trips
    // the `actualParent` from the commit-notify re-sync signal. Min length 1:
    // an empty version is a protocol misuse (the re-sync path always carries a
    // concrete head; the empty-baseline case is materialize's job).
    version: z.string().min(1),
  })
  .strict();
export type WorkspaceExportBaselineBundleRequest = z.infer<
  typeof WorkspaceExportBaselineBundleRequestSchema
>;

// ---------------------------------------------------------------------------
// workspace.read — Phase 2 (attachments translation, D3).
//
// Exposes the host's `workspace:read` service hook to runners over IPC.
// The runner's attachment-translation pass uses this to fetch attachment
// bytes that the host committed via `attachments:commit` after session
// start (the runner's /agent doesn't auto-sync mid-session).
//
// Auth: caller's bearer token resolves to a session row; the host-side
// handler uses the session's workspaceId to scope `workspace:read`.
// Cross-session reads are impossible — there's no session id on the wire.
//
// Payload: path is workspace-relative (matches what attachment blocks
// carry, e.g. ".ax/uploads/<conv>/<turn>/file.pdf"). Bytes ride
// base64-encoded for JSON safety.
export const WorkspaceReadRequestSchema = z.object({
  // Defense in depth at the wire boundary: the same workspace-relative
  // path rule the AttachmentBlock schema enforces. A malformed runner
  // call (absolute path, `..` traversal, drive root, NUL byte) surfaces
  // as a clean 400 VALIDATION here rather than as a confusing
  // git-cat-file error one hop later.
  path: z
    .string()
    .min(1)
    .refine(
      isWorkspaceRelativePath,
      'path must be workspace-relative (no leading slash, no "..", no drive root, no NUL)',
    ),
});
export type WorkspaceReadRequest = z.infer<typeof WorkspaceReadRequestSchema>;

export const WorkspaceReadResponseSchema = z.discriminatedUnion('found', [
  z.object({
    found: z.literal(true),
    // Same canonical-base64 refinement BundleBytesSchema uses: malformed
    // payloads surface here, not as confusing decode failures downstream.
    // Empty string allowed for parity with bundleBytes (a known-found
    // zero-byte file is valid).
    bytesBase64: z
      .string()
      .refine((s) => s === '' || BASE64_RE.test(s), {
        message: 'bytesBase64 must be empty or canonical base64',
      }),
  }),
  z.object({ found: z.literal(false) }),
]);
export type WorkspaceReadResponse = z.infer<typeof WorkspaceReadResponseSchema>;

// ---------------------------------------------------------------------------
// proxy.drain-egress-blocks — agent-visible egress-block note.
//
// Exposes the host's `proxy:drain-session-egress-blocks` service hook to
// runners over IPC. The runner drains this at PostToolUse: if the agent's
// command was egress-blocked (an allowlist miss — e.g. a prebuilt-binary CLI
// downloading from a GitHub release), the host returns the blocked host(s) and
// the runner injects an actionable remediation note into the agent's context
// (otherwise the agent sees only a cryptic `statusCode=403` and flails).
//
// Auth: the request body is EMPTY by design — exactly like session.get-config.
// The host reads the session from `ctx.sessionId` (bearer-token-bound by the
// IPC server), NEVER from the body, so an agent can only drain ITS OWN session.
// A non-empty body is a hard 400 here (`.strict({})`), keeping the
// no-sessionId-smuggling invariant visible at the schema layer. The drained
// hosts are destinations the agent already chose to reach — no information gain
// and no egress change (this never widens an allowlist; cf. proxy:add-host,
// which is deliberately NOT exposed over IPC for exactly that reason).
export const ProxyDrainEgressBlocksRequestSchema = z.object({}).strict();
export type ProxyDrainEgressBlocksRequest = z.infer<
  typeof ProxyDrainEgressBlocksRequestSchema
>;

export const ProxyDrainEgressBlocksResponseSchema = z.object({
  /** Hostnames the caller's session was allowlist-blocked on since the last
   *  drain (deduped, capped, surface-once). Empty when nothing was blocked or
   *  the deployment has no egress proxy (the single-session CLI). */
  hosts: z.array(z.string()),
});
export type ProxyDrainEgressBlocksResponse = z.infer<
  typeof ProxyDrainEgressBlocksResponseSchema
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
// I10 — switching agents = new session, not mutate). `displayName` is the
// agent's display name (the runner's fallback identity when no `.ax/IDENTITY.md`
// exists) and `systemPromptAugment` carries the host `system-prompt:augment`
// contribution (e.g. the memory-strata injection). Both flow into the LLM's
// prompt; the runner must NOT interpolate them into shell commands, file paths,
// or HTML. TASK-142 dropped the legacy `systemPrompt` field when the
// `agents_v1_agents.system_prompt` column was removed — identity now lives in
// the agent's `.ax/` files (Invariant #4).
//
// Phase E (2026-05-09): the response also carries `runnerSessionId`.
// The IPC handler composes from two bus hooks (`session:get-config` +
// `conversations:get-metadata`) to assemble the wire response. The
// bus-level `session:get-config` output type stays unchanged; only the
// wire surface picks up the field. The session backend does NOT own
// conversation rows — keeping the field out of `session:get-config`'s
// bus-level type preserves that boundary.
// ---------------------------------------------------------------------------

export const SessionGetConfigRequestSchema = z.object({}).strict();
export type SessionGetConfigRequest = z.infer<typeof SessionGetConfigRequestSchema>;

export const AgentConfigSchema = z.object({
  /** The agent's display name — the runner's fallback identity, used only when
   * the agent has no `.ax/IDENTITY.md` of its own (TASK-142). */
  displayName: z.string(),
  /** The host `system-prompt:augment` contribution (e.g. memory-strata's
   * injection), prepended on top of the composed system prompt in normal mode.
   * Empty string when no augment provider is registered. */
  systemPromptAugment: z.string(),
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
   * this to decide whether `runnerSessionId` is meaningful.
   *
   * The host populates this from the session row (Task 15 added a
   * `conversation_id` column to the session backend; the orchestrator
   * sets it at session-creation time). NEVER `undefined` — explicit null
   * keeps the wire shape stable across the schema bump (an absent field
   * would force every consumer to branch on three states).
   */
  conversationId: z.string().nullable(),
  /**
   * Phase E (2026-05-09): the bound runner-side session id, or null if
   * no runner has ever bound one (or `conversationId` is null). Runners
   * branch on `runnerSessionId !== null` to choose SDK
   * `resume(sessionId)` vs a fresh SDK session. Wire name is camelCase,
   * opaque, and does NOT leak the specific runner shape (no
   * `sdk_session_id`, no `jsonl_path`).
   *
   * NEVER `undefined` — explicit null keeps the wire shape stable and
   * forces consumers to branch on three states (string, null,
   * schema-fail) rather than treat absent as "no opinion".
   */
  runnerSessionId: z.string().nullable(),
});
export type SessionGetConfigResponse = z.infer<typeof SessionGetConfigResponseSchema>;

// ---------------------------------------------------------------------------
// conversation.store-runner-session
//
// Runner → host RPC fired ONCE per session, the first time the SDK emits a
// `system/init` message that carries a session_id. The runner forwards that
// id so the host can persist it on the conversation row; on the next boot
// the runner reads it back from the `session.get-config` response's
// `runnerSessionId` field and calls `query({ resume: sessionId })` instead
// of starting a fresh SDK session. The SDK already owns durable transcripts
// on disk under `~/.claude/projects/<sessionId>`, so resume rehydrates the
// whole conversation without us replaying anything from a host DB.
//
// Authz on the host: the bus-side `conversations:store-runner-session` hook
// runs a `ctx.userId`-scoped UPDATE only — it does NOT call `agents:resolve`
// (Phase B's posture; see `packages/conversations/src/plugin.ts:234-238`).
// The runner authenticates IPC via its session bearer token, the IPC server
// resolves the token to ctx.userId, and that userId is what reaches the
// UPDATE.
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

// ---------------------------------------------------------------------------
// blob.put / blob.get — TASK-68 (out-of-git Part C). The runner-side binary
// blob-store callers.
//
// `blob.put` is the REQUEST-direction binary channel: the runner streams the
// artifact's raw bytes as the HTTP request body (`Content-Type:
// application/octet-stream`, NOT a JSON envelope — so the bytes bypass the
// 4 MiB `MAX_FRAME` JSON cap exactly like the response-direction
// materialize/export-baseline-bundle channels do, just inbound). There is
// therefore NO request *schema* — the body is opaque bytes. The RESPONSE is a
// small JSON envelope `{sha256, size}`, validated below.
//
// `blob.get` is the response-direction binary channel (same shape as
// materialize): a small JSON request `{sha256}` and a raw octet-stream
// response body (the blob bytes, drained to a temp file). No response schema
// (binary body) — cf. the dispatch table in `ipc-client.ts`.
//
// `sha256` is a CONTENT hash on the wire, not a backend pointer (I1) — the
// same storage-agnostic identity the `blob:*` bus hook + the
// `attachments:commit` output already carry. The strict regex defends the
// host's `blob:get` against a malformed key reaching the filesystem shard
// (defense in depth — the fs store re-validates with the identical regex).
// ---------------------------------------------------------------------------

const SHA256_RE = /^[a-f0-9]{64}$/;

export const BlobPutResponseSchema = z.object({
  sha256: z.string().regex(SHA256_RE),
  size: z.number().int().nonnegative(),
});
export type BlobPutResponse = z.infer<typeof BlobPutResponseSchema>;

export const BlobGetRequestSchema = z
  .object({
    sha256: z.string().regex(SHA256_RE, 'sha256 must be 64 lowercase-hex chars'),
  })
  .strict();
export type BlobGetRequest = z.infer<typeof BlobGetRequestSchema>;

// ---------------------------------------------------------------------------
// artifact.publish — TASK-68 (out-of-git Part C, outbound). After the runner
// streams an artifact's bytes via `blob.put`, it posts this small metadata
// envelope so the host inserts the artifact row and mints the stable
// `ax://artifact/<id>` URL.
//
// Field names are storage-agnostic (I1): `conversationId` scopes ownership,
// `sha256` is the content hash linking the row to the stored blob, `path` is
// the workspace-relative display/scope key the transcript + download ACL use,
// `displayName`/`mediaType` are untrusted display text (the renderer treats
// them as untrusted; never shell-interpolated). No backend vocabulary.
// ---------------------------------------------------------------------------

export const ArtifactPublishRequestSchema = z
  .object({
    conversationId: z.string().min(1).max(256),
    sha256: z.string().regex(SHA256_RE),
    path: z.string().min(1).max(1024),
    displayName: z.string().min(1).max(1024),
    mediaType: z.string().min(1).max(256),
    size: z.number().int().nonnegative(),
  })
  .strict();
export type ArtifactPublishRequest = z.infer<typeof ArtifactPublishRequestSchema>;

export const ArtifactPublishResponseSchema = z.object({
  artifactId: z.string(),
  downloadUrl: z.string(),
});
export type ArtifactPublishResponse = z.infer<typeof ArtifactPublishResponseSchema>;

// ---------------------------------------------------------------------------
// attachments.list — TASK-68 (out-of-git Part C, inbound). At session start —
// and on a warm-runner rebind bringing a new upload (TASK-78) — the runner
// enumerates the bound conversation's uploads so it can pull each blob
// (`blob.get`) and materialize the read-only working copy at the path advertised
// to the model. The host scopes the query to ctx.userId (the bearer token's
// user) AND the requested conversationId.
//
// `path` is the workspace-relative key (`.ax/uploads/<conv>/<turnId>/<file>`)
// the runner materializes at `<workspaceRoot>/.ax/uploads/...`; `sha256`
// addresses the blob; the rest is display metadata. No backend vocabulary (I1).
// ---------------------------------------------------------------------------

export const AttachmentsListRequestSchema = z
  .object({
    conversationId: z.string().min(1).max(256),
  })
  .strict();
export type AttachmentsListRequest = z.infer<typeof AttachmentsListRequestSchema>;

export const AttachmentsListResponseSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      sha256: z.string().regex(SHA256_RE),
      mediaType: z.string(),
      displayName: z.string(),
      sizeBytes: z.number().int().nonnegative(),
    }),
  ),
});
export type AttachmentsListResponse = z.infer<typeof AttachmentsListResponseSchema>;

// ---------------------------------------------------------------------------
// session.append-transcript / .replace-transcript / .get-transcript — TASK-67
// (out-of-git Part B / B2). The runner-side resume-transcript callers.
//
// The transcript is the SDK's per-session jsonl, taken OUT of git and stored as
// opaque rows (one per line). At the result boundary the runner ships the DELTA
// of new lines via `session.append-transcript`; on resume it fetches the
// reconstructed bytes via `session.get-transcript`.
//
// SECURITY: there is intentionally NO `conversationId` in any request body. The
// host derives it from the runner's session row (the bearer token → ctx →
// session:get-config), exactly as `session.get-config` reads ctx not the body.
// A runner therefore cannot aim a transcript at a foreign conversation. The
// lines are an UNTRUSTED, adversarial SDK/model artifact: stored verbatim, never
// executed or shell-interpolated, only re-emitted to the SDK on resume.
//
// Field names are storage-neutral (I1): `fromSeq`/`prefixHash`/`maxSeq` describe
// an append-with-integrity-check over an ordered opaque-line store — no git/
// jsonl/sqlite vocabulary. `seq` is a per-conversation monotonic counter, NOT a
// git oid or commit.
//
// `append-transcript` and `replace-transcript` are BOTH the REQUEST-direction
// binary channel: the runner streams the jsonl bytes (the per-turn DELTA for
// append, the WHOLE file for replace's resync path) as `application/octet-stream`
// and the host splits on `\n`. The per-turn delta moved off the JSON channel
// because a single turn that Reads a large attachment writes a jsonl line
// carrying base64 image/document blocks — which overflowed the 4 MiB JSON
// `MAX_FRAME` and terminated the runner. So neither has a JSON *body* schema;
// append's `fromSeq`/`prefixHash` integrity metadata ride as QUERY PARAMS,
// validated by `SessionAppendTranscriptMetaSchema` (query strings → coerced).
// `get-transcript` is the response-direction binary channel (same shape as
// materialize): a small JSON request and a raw octet-stream response body (the
// joined bytes, drained to a temp file) — so NO response schema (cf. the
// dispatch table in `ipc-client.ts`).
// ---------------------------------------------------------------------------

// Query-carried integrity metadata for `session.append-transcript`. Both values
// arrive as URL query strings, so `fromSeq` is matched as digits then coerced;
// `prefixHash` keeps the same 64-lowercase-hex shape it had as a JSON field. The
// delta lines themselves are the raw octet-stream body, NOT in here. `.strict()`
// is moot (the handler builds the object from exactly these two getters) but
// documents that no other field is meaningful — a smuggled `?conversationId=…`
// is never read (the host resolves it from the session row).
export const SessionAppendTranscriptMetaSchema = z
  .object({
    fromSeq: z
      .string()
      .regex(/^\d+$/, 'fromSeq must be a non-negative integer')
      .transform((s) => Number(s))
      .refine((n) => Number.isSafeInteger(n), 'fromSeq out of range'),
    prefixHash: z.string().regex(SHA256_RE, 'prefixHash must be 64 lowercase-hex chars'),
  })
  .strict();
export type SessionAppendTranscriptMeta = z.infer<
  typeof SessionAppendTranscriptMetaSchema
>;

export const SessionAppendTranscriptResponseSchema = z.object({
  outcome: z.enum(['appended', 'resync-required']),
  maxSeq: z.number().int().nonnegative(),
});
export type SessionAppendTranscriptResponse = z.infer<
  typeof SessionAppendTranscriptResponseSchema
>;

export const SessionReplaceTranscriptResponseSchema = z.object({
  maxSeq: z.number().int().nonnegative(),
});
export type SessionReplaceTranscriptResponse = z.infer<
  typeof SessionReplaceTranscriptResponseSchema
>;

export const SessionGetTranscriptRequestSchema = z.object({}).strict();
export type SessionGetTranscriptRequest = z.infer<
  typeof SessionGetTranscriptRequestSchema
>;

// ---------------------------------------------------------------------------
// skill.propose — TASK-74 (out-of-git Part D / §D1–D2). The runner-side skill
// authoring chokepoint.
//
// The agent writes a bundle into `<root>/.skill-draft/<id>/` (the durable
// per-agent mount when wired, else the ephemeral scratch tier — TASK-165) then
// calls the `skill_propose` sandbox tool. Its
// executor reads + structurally validates the draft dir, then posts THIS
// envelope so the host's `skills:propose` hook gates + stores it (DB row +
// blob). This is an ordinary JSON `call()` action — the bundle EXTRA files ride
// `files[]` inline (validateBundleFiles caps them at ≤16 files / ≤512 KiB total,
// far under the 4 MiB JSON `MAX_FRAME`), so there is NO raw-octet-stream channel
// here (unlike artifact_publish, whose bytes are unbounded). The host writes the
// files to the blob store itself, reusing the same byte-store path skills:upsert
// uses — one storage path (I4).
//
// SECURITY: there is intentionally NO conversationId / agentId / ownerUserId in
// the request body. The host derives the (user, agent) scope from the runner's
// session row (bearer token → ctx → session:get-config), exactly as
// session.get-config / session.append-transcript do — so a runner cannot aim a
// proposal at a foreign agent. `origin` is FIXED to 'authored' on the wire (the
// schema is a single-literal enum): the runner only ever proposes a bundle IT
// composed; `imported`/`attached` are host-side admin/catalog actions that never
// come from the untrusted runner (I5 — the runner can't claim a more-trusted
// provenance to dodge the gate).
//
// Field names are skill-domain, not backend vocabulary (I1): `manifestYaml` /
// `bodyMd` / `files` / `capabilityProposal` are the skill bundle shape;
// `origin` is a trust-provenance enum, not a storage id. The bundle bytes that
// land in the blob store are keyed by a content sha256 INSIDE the host hook —
// never surfaced on this wire. `manifestYaml` / `bodyMd` / file contents are
// UNTRUSTED, adversarial model output: stored as opaque bytes, structurally
// validated, scanned, and gated — never executed or shell-interpolated.
// ---------------------------------------------------------------------------

// Mirror of skills-parser CapabilitySlot — re-declared at the wire boundary
// (I2: ipc-protocol must not import @ax/skills-parser, the host kernel layer).
// Kept structurally in sync; if skills-parser's shape drifts, reconcile here.
const SkillProposeSlotSchema = z.object({
  slot: z.string(),
  kind: z.literal('api-key'),
  description: z.string().optional(),
  account: z.string().optional(),
});
const SkillProposeMcpSchema = z.object({
  name: z.string(),
  transport: z.union([z.literal('stdio'), z.literal('http')]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  allowedHosts: z.array(z.string()),
  credentials: z.array(SkillProposeSlotSchema),
});
const SkillProposeCapabilitiesSchema = z.object({
  allowedHosts: z.array(z.string()),
  credentials: z.array(SkillProposeSlotSchema),
  mcpServers: z.array(SkillProposeMcpSchema),
  packages: z.object({ npm: z.array(z.string()), pypi: z.array(z.string()) }),
});

export const SkillProposeRequestSchema = z
  .object({
    // The raw YAML frontmatter (between the `---` fences), verbatim. The host
    // re-parses + re-validates it (defense-in-depth at the trust boundary).
    manifestYaml: z.string().min(1).max(64 * 1024),
    bodyMd: z.string().max(512 * 1024),
    // Bundle EXTRA (non-SKILL.md) files. Bounded by the host's validateBundleFiles
    // (≤16 files / ≤512 KiB total) — re-validated host-side; the wire cap here is
    // a coarse sanity wall so a malformed runner can't blow the JSON frame.
    files: z
      .array(z.object({ path: z.string().max(256), contents: z.string() }))
      .max(16),
    // The agent's capability PROPOSAL (parsed from the frontmatter). The gate
    // classifies on this (∅ + authored + clean scan → active; any cap → pending).
    capabilityProposal: SkillProposeCapabilitiesSchema,
    // FIXED to 'authored' — the runner only proposes bundles it composed.
    origin: z.literal('authored'),
  })
  .strict();
export type SkillProposeRequest = z.infer<typeof SkillProposeRequestSchema>;

export const SkillProposeResponseSchema = z.object({
  skillId: z.string(),
  // The gate verdict (design §D3). `active` = materializes next spawn; `pending`
  // = awaits the approval card; `quarantined` = a scan hit, omitted from the
  // projection (reason carried separately to the agent via the tool result).
  status: z.enum(['active', 'pending', 'quarantined']),
  // On a quarantine (or a structural/scan reason worth surfacing) the host
  // returns a short, model-safe reason so the agent can tell the user what to
  // fix. Absent on a clean active/pending.
  reason: z.string().optional(),
});
export type SkillProposeResponse = z.infer<typeof SkillProposeResponseSchema>;

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
