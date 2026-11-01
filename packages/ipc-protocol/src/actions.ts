import { z } from 'zod';
import { HOLD_NOTE_MAX } from '@ax/core';
import {
  ATTACHMENT_FILENAME_MAX,
  ATTACHMENT_MEDIA_TYPE_MAX,
  AttachmentIdSchema,
  CONTENT_BLOCKS_MAX,
  ContentBlockSchema,
} from './content-blocks.js';

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
  // Phase 2 (attachments). Optional richer payload — the chat-messages
  // handler sends the person's `attachment` blocks here (addressed by id).
  // When present, the runner prefers this over `content`. Omitting the
  // field reproduces the string-only shape exactly.
  contentBlocks: z.array(ContentBlockSchema).max(CONTENT_BLOCKS_MAX).optional(),
  /**
   * Phase 3 (attachments, 2026-05-18). Server-minted user-turn id the
   * chat-messages handler stamps on each user message. Attachments do not
   * depend on it: they are committed and addressed by their own id.
   * Optional; paths that mint no turn id omit it.
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
   * Present-participle activity clause (e.g. `'Reading email'`), never an
   * outcome. Authored in-repo per tool, not model-facing. MCP-sourced
   * descriptors never set this. See `@ax/core`'s `ToolDescriptor` for the
   * full rationale.
   */
  activityPhrase: z.string().max(40).optional(),
  /**
   * The unit this tool iterates over, when it iterates (e.g. `'messages'`).
   * See `@ax/core`'s `ToolDescriptor` for the full rationale.
   */
  countable: z.string().max(40).optional(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

// ---------------------------------------------------------------------------
// tool.pre-call
// ---------------------------------------------------------------------------

export const ToolPreCallRequestSchema = z.object({
  call: ToolCallSchema,
});
export type ToolPreCallRequest = z.infer<typeof ToolPreCallRequestSchema>;

/**
 * Ceiling on the `reject` arm's `reason`, in UTF-16 code units (zod's
 * `.max()` unit). Same number as the `hold` arm's `note` on purpose: both
 * are prose the model reads and the transcript keeps, so they get the same
 * budget. Today's longest legit reason (`@ax/decisions`' `denialSentence`
 * with a capped capability and tool name) is ~300 characters.
 *
 * The host handler (`@ax/ipc-core`'s tool.pre-call) truncates to this BEFORE
 * the response parse, so an over-long deny still arrives as a deny. A cap
 * that only threw here would turn it into a 500 and then the runner's
 * generic gate-failed deny — still closed, but carrying the wrong message.
 */
export const PRE_CALL_REJECT_REASON_MAX = HOLD_NOTE_MAX;

export const ToolPreCallResponseSchema = z.discriminatedUnion('verdict', [
  z.object({
    verdict: z.literal('allow'),
    modifiedCall: ToolCallSchema.optional(),
  }),
  z.object({
    verdict: z.literal('reject'),
    reason: z.string().max(PRE_CALL_REJECT_REASON_MAX),
  }),
  // `hold` — a human must see this before it happens. Returns as fast as
  // `reject` (the 10 s ceiling in IPC_TIMEOUTS_MS makes waiting for a person
  // impossible here) and differs in MEANING: do not retry, do not route
  // around it, tell the user what you were about to do, end the turn.
  // `note` is prose for the model to relay; `decisionId` is the opaque handle
  // the durable decision is filed under.
  z.object({
    verdict: z.literal('hold'),
    decisionId: z.string().min(1),
    note: z.string().min(1).max(HOLD_NOTE_MAX),
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
// agent's display name (the runner's fallback identity line when the agent has
// no identity text), `systemPromptAugment` carries the host
// `system-prompt:augment` contribution (e.g. @ax/memory's memory block), and
// `identity` (TASK-989) carries the agent's identity, soul and people's
// Instructions from @ax/agents plus the host's bootstrap-mode decision, read
// once at spawn. All of them flow into the LLM's prompt; the runner must NOT
// interpolate them into shell commands, file paths, or HTML. TASK-142 dropped
// the legacy `systemPrompt` field when the `agents_v1_agents.system_prompt`
// column was removed; TASK-989 moved identity out of the agent's files and
// into @ax/agents (Invariant #4).
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

/** TASK-989 — the agent's identity from @ax/agents, frozen at spawn. Prose for
 *  the LLM prompt only; never interpolated into a shell command, path or HTML.
 *  Optional on `AgentConfigSchema`: absent on session rows written before this
 *  field and when the host has no identity store — the runner then composes
 *  normal mode with the display-name identity line. No `.max()` caps: sizes
 *  are bounded when the text is written, not on the wire. */
export const AgentIdentityConfigSchema = z.object({
  identity: z.string(),
  soul: z.string(),
  instructions: z.string(),
  /** Host decision: bootstrap pending AND a person present. */
  bootstrapMode: z.boolean(),
});
export type AgentIdentityConfig = z.infer<typeof AgentIdentityConfigSchema>;

export const AgentConfigSchema = z.object({
  /** The agent's display name — the runner's fallback identity line, used only
   * when the agent has no identity text of its own (TASK-142, TASK-989). */
  displayName: z.string(),
  /** The joined host `system-prompt:augment:*` contributions (e.g. @ax/memory's
   * memory block), prepended on top of the composed system prompt in normal mode.
   * Empty string when no augment provider contributes (or a required one failed). */
  systemPromptAugment: z.string(),
  /** The `rules` section of the host `system-prompt:augment:*` contributions
   * that the runner prepends in bootstrap mode. (The people's Instructions no
   * longer arrive here — they travel in `identity.instructions`, TASK-989.)
   * Optional: absent means '' (no bootstrap augment) — session rows persisted
   * before this field existed don't carry it. Flows into the LLM prompt like
   * `systemPromptAugment`; the runner must NOT interpolate it into shell
   * commands, file paths, or HTML. */
  systemPromptBootstrapAugment: z.string().optional(),
  allowedTools: z.array(z.string()),
  /** Canonical AX tool names (e.g. `Bash`, `web_search`, `mcp.<id>.<tool>`)
   * the agent's tool policy DENIES (verdict or ceiling). Catalog hygiene only:
   * the runner hides these so the model is not offered tools it will be
   * refused — enforcement stays host-side on `tool:pre-call`. Optional: absent
   * means no extra denies (session rows persisted before this field existed
   * don't carry it). Independent of `allowedTools` (empty = unrestricted). */
  disallowedTools: z.array(z.string()).optional(),
  mcpConfigIds: z.array(z.string()),
  model: z.string(),
  /** Runner id (e.g. `'claude-sdk'`) the host resolves to a binary path via
   * `ChatOrchestratorConfig.runnerBinaries`. `z.string()`, not a zod enum: the
   * wire is a transport boundary and the authoritative allow-list
   * (`SUPPORTED_RUNNERS`) lives in `@ax/agents` — a second enum here would
   * need editing again in PR 3 for no safety gain. */
  runner: z.string(),
  /** TASK-989 — see `AgentIdentityConfigSchema`. Optional: absent → normal
   * mode with the display-name identity line. */
  identity: AgentIdentityConfigSchema.optional(),
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
// Only the response body is protocol-level — the five variants are what
// the sandbox inbox loop branches on. (`decision-resolved` joined the
// original three in TASK-227; `interrupt` in TASK-688.)
//
// Cursor semantics: the response `cursor` is the NEXT cursor the client
// should request. On a real delivery (`user-message` / `cancel` /
// `interrupt` / `decision-resolved`) it's the index of the delivered entry + 1; on
// `timeout` it's the cursor the client sent (echo — no entry was
// delivered, so no advancement). The sandbox inbox loop stores this value
// verbatim and passes it back on the next GET.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// blob.put / blob.get — TASK-68 (out-of-git Part C). The runner-side binary
// blob-store callers.
//
// `blob.put` is the REQUEST-direction binary channel: the runner streams the
// artifact's raw bytes as the HTTP request body (`Content-Type:
// application/octet-stream`, NOT a JSON envelope — so the bytes bypass the
// 4 MiB `MAX_FRAME` JSON cap exactly like the response-direction `blob.get` /
// `session.get-transcript` channel does, just inbound). There is therefore NO
// request *schema* — the body is opaque bytes. The RESPONSE is a small JSON
// envelope `{sha256, size}`, validated below.
//
// `blob.get` is the response-direction binary channel: a small JSON request
// `{sha256}` and a raw octet-stream response body (the blob bytes, drained to
// a temp file). No response schema (binary body) — cf. the dispatch table in
// `ipc-client.ts`. The host serves only a blob the session's own conversation's
// uploads reference, and answers everything else with the same 404 a missing
// blob gets (TASK-1009): knowing a hash is not permission to read it back
// over this action.
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
// the file's location relative to its publish root, used only as the row's
// re-publish key (publishing the same file again updates its row) and never
// handed back out — the chat chip and the download address the artifact by
// `artifactId`. `displayName`/`mediaType` are untrusted display text (the
// renderer treats them as untrusted; never shell-interpolated); they are capped
// at the `attachment` block's limits so every recorded artifact can become a
// chip. No backend vocabulary.
// ---------------------------------------------------------------------------

export const ArtifactPublishRequestSchema = z
  .object({
    conversationId: z.string().min(1).max(256),
    sha256: z.string().regex(SHA256_RE),
    path: z.string().min(1).max(1024),
    displayName: z.string().min(1).max(ATTACHMENT_FILENAME_MAX),
    mediaType: z.string().min(1).max(ATTACHMENT_MEDIA_TYPE_MAX),
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
// and when a later message brings an upload the runner has not seen — the
// runner enumerates its bound conversation's uploads so it can pull each blob
// (`blob.get`) and keep a working copy inside the sandbox. The host serves
// only the conversation the session is bound to (`ctx.conversationId`, from
// the bearer token — any other is refused) and only rows owned by ctx.userId.
//
// Each entry: `attachmentId` (the id the transcript's `attachment` block
// carries, so a turn's block finds its copy), `filename` (display name; the
// runner sanitizes it before using it on disk), `sha256` (addresses the blob,
// and lets the runner check its copy is intact), `mediaType`, `sizeBytes`.
// Oldest first, so a fresh runner given the same list derives the same names.
// No path and no backend vocabulary (I1).
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
      attachmentId: AttachmentIdSchema,
      filename: z.string().min(1).max(ATTACHMENT_FILENAME_MAX),
      sha256: z.string().regex(SHA256_RE),
      mediaType: z.string().min(1).max(ATTACHMENT_MEDIA_TYPE_MAX),
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
// `blob.get`): a small JSON request and a raw octet-stream response body (the
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
// session.get-display-history — cross-runner history reconstruction.
// See docs/plans/2026-08-21-cross-runner-history-reconstruction.md.
//
// The runner-neutral display log, as messages a runner can seed its own
// transcript from. Called on exactly one path: a runner that was handed a
// transcript written by a DIFFERENT runner (`write()` answered `'unusable'`)
// and would otherwise start blank, losing a conversation the user can still
// see on screen.
//
// SECURITY, same shape as the transcript actions above: the request carries NO
// ids. The conversation is resolved host-side from the runner's own session row
// (bearer token → ctx.sessionId → `session:get-config` → conversationId), so a
// runner cannot ask about a conversation that is not its own. That is the whole
// reason this takes an empty body rather than a conversationId.
//
// FILTERING IS HOST-SIDE, deliberately. The host returns user/assistant TEXT
// only — no `tool_use`, no `tool_result`, no `thinking`. Two reasons, and
// neither is tidiness:
//
//   - A `tool_use` without its matching `tool_result` is a 400 from the
//     provider, and the display log splits the pair across turns. Not sending
//     them is what makes reconstruction safe without a re-pairing pass.
//   - Anthropic's thinking blocks are SIGNED. A reconstructed one cannot be
//     re-signed and must never be replayed.
//
// Doing it host-side means every runner inherits the guarantee instead of each
// being trusted to re-derive it.
// ---------------------------------------------------------------------------

export const SessionGetDisplayHistoryRequestSchema = z.object({}).strict();
export type SessionGetDisplayHistoryRequest = z.infer<
  typeof SessionGetDisplayHistoryRequestSchema
>;

export const SessionGetDisplayHistoryResponseSchema = z.object({
  /**
   * Prior turns oldest-first, ready to seed a transcript. `role` is faithful to
   * the original turn — a tool result is never relabelled as a user message,
   * which would let tool output impersonate the user.
   */
  messages: z.array(AgentMessageSchema),
  /**
   * True when older turns were dropped to stay inside the bounds below, so the
   * runner can tell the model its history is partial rather than letting it
   * infer a clean start.
   */
  truncated: z.boolean(),
});
export type SessionGetDisplayHistoryResponse = z.infer<
  typeof SessionGetDisplayHistoryResponseSchema
>;

// ---------------------------------------------------------------------------
// skill.propose — TASK-74 (out-of-git Part D / §D1–D2). The runner-side skill
// authoring chokepoint.
//
// The agent writes a bundle into `<home>/.skill-draft/<id>/` (its home, the
// durable per-agent files mount — TASK-165) then calls the `skill_propose`
// sandbox tool. Its executor reads + structurally validates the draft dir, then
// posts THIS
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

/**
 * Per-list limits on the `capabilityProposal` hint (TASK-945). The host has
 * ignored the hint since TASK-100 and the runner sends empty lists, so these
 * only refuse garbage. They match @ax/connectors' write limits for the same
 * Capabilities shape: 64 hosts, 32 credential slots and 8 MCP servers (the
 * sandbox wire's per-skill limits), and 64 packages per npm/pypi list. An MCP
 * server's own hosts and slots use the same numbers.
 */
export const SKILL_PROPOSE_CAPABILITY_LIMITS = {
  allowedHosts: 64,
  credentials: 32,
  mcpServers: 8,
  packages: 64,
} as const;

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
  transport: z.literal('http'),
  url: z.string().optional(),
  allowedHosts: z.array(z.string()).max(SKILL_PROPOSE_CAPABILITY_LIMITS.allowedHosts),
  credentials: z.array(SkillProposeSlotSchema).max(SKILL_PROPOSE_CAPABILITY_LIMITS.credentials),
});
const SkillProposeCapabilitiesSchema = z.object({
  allowedHosts: z.array(z.string()).max(SKILL_PROPOSE_CAPABILITY_LIMITS.allowedHosts),
  credentials: z.array(SkillProposeSlotSchema).max(SKILL_PROPOSE_CAPABILITY_LIMITS.credentials),
  mcpServers: z.array(SkillProposeMcpSchema).max(SKILL_PROPOSE_CAPABILITY_LIMITS.mcpServers),
  packages: z.object({
    npm: z.array(z.string()).max(SKILL_PROPOSE_CAPABILITY_LIMITS.packages),
    pypi: z.array(z.string()).max(SKILL_PROPOSE_CAPABILITY_LIMITS.packages),
  }),
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
    // A DEPRECATED, ignored hint (TASK-100): a skill declares no capabilities,
    // the runner sends empty lists, and the host gate keys only on origin and
    // the safety scan. Kept on the wire for schema stability, and bounded.
    capabilityProposal: SkillProposeCapabilitiesSchema,
    // FIXED to 'authored' — the runner only proposes bundles it composed.
    origin: z.literal('authored'),
  })
  .strict();
export type SkillProposeRequest = z.infer<typeof SkillProposeRequestSchema>;

/**
 * Ceiling on `skill.propose`'s `reason`, in UTF-16 code units. The reason
 * comes from the skill safety scan (plugin/validator text), so the host
 * handler clamps to this before it parses its response; the schema cap is the
 * wire boundary for anything that does not go through that handler.
 */
export const SKILL_PROPOSE_REASON_MAX = HOLD_NOTE_MAX;

export const SkillProposeResponseSchema = z.object({
  skillId: z.string(),
  // The gate verdict (design §D3). `active` = materializes next spawn; `pending`
  // = awaits the approval card; `quarantined` = a scan hit, omitted from the
  // projection (reason carried separately to the agent via the tool result).
  status: z.enum(['active', 'pending', 'quarantined']),
  // On a quarantine (or a structural/scan reason worth surfacing) the host
  // returns a short, model-safe reason so the agent can tell the user what to
  // fix. Absent on a clean active/pending.
  reason: z.string().max(SKILL_PROPOSE_REASON_MAX).optional(),
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
  // TASK-688 — "stop the turn that is running, and stay warm". NOT `cancel`
  // (which ends the session and exits the runner): the person pressed Stop on a
  // reply, they did not close the tab. Payload-free on purpose — nothing a
  // person or a model wrote rides this entry, so there is no string for the
  // runner to trust. A runner with no turn in flight drops it.
  z.object({
    type: z.literal('interrupt'),
    cursor: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('timeout'),
    cursor: z.number().int().nonnegative(),
  }),
  // A decision the agent held earlier has been resolved by a human. Delivered
  // ONLY to a still-warm (attended) session — an unattended decision resolves
  // through the host replay path (AW-5) and no runner ever hears about it.
  //
  // `note` is HOST-AUTHORED: it tells the agent what the person decided, in
  // words the agent may relay. It never carries the person's free text and it
  // never carries `call.input` — the model-authored half of the held call is
  // stored on the decision row and is not echoed back into a line the model
  // reads as instruction.
  //
  // The agent's re-issued call is NOT trusted to be faithful: @ax/decisions
  // holds a standing approval keyed on the call FINGERPRINT (AW-4), so an
  // unchanged call passes the gate exactly once and any change to it holds
  // again. This message is a prompt, not an authorisation.
  z.object({
    type: z.literal('decision-resolved'),
    decisionId: z.string().min(1),
    outcome: z.enum(['approved', 'dismissed']),
    note: z.string().min(1).max(HOLD_NOTE_MAX),
    // TASK-278 — the continuation turn's chat correlation, minted by the
    // approve route and echoed from `decisions:approve`. Optional: entries
    // queued before this field existed (or for a turn with no live watcher)
    // carry nothing, and the runner then runs dark exactly as before.
    // Bounded like every other short id on this wire.
    reqId: z.string().min(1).max(128).optional(),
    cursor: z.number().int().nonnegative(),
  }),
]);
export type SessionNextMessageResponse = z.infer<
  typeof SessionNextMessageResponseSchema
>;
