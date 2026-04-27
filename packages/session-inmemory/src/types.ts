import type { ChatMessage } from '@ax/core';

// ---------------------------------------------------------------------------
// AgentConfig — frozen-at-creation snapshot of a resolving agent's settings.
//
// Carried on the session record (see store.ts) and returned to the runner
// via `session:get-config` (Task 6d). The fields are intentionally model-
// vocab — they ARE the runner's boot configuration. The shape is duplicated
// (rather than imported) from @ax/agents because session plugins must not
// import @ax/agents (Invariant I2 — no cross-plugin imports). A drift would
// show up at the resolveAgent → session:create call site.
//
// NB: `systemPrompt` is USER-AUTHORED (an admin pasted it into POST /admin/
// agents). Subscribers downstream of session:create that read this field
// must treat it as untrusted — it flows into an LLM prompt, never into a
// shell, never into a SQL query, never into HTML. Branding lives at the
// hook surface (@ax/chat-orchestrator → sandbox:open-session) where the
// flow is observable; carrying the brand all the way through every plain
// `string` field would balloon the type for limited gain.
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** User-authored. Treat as untrusted; intended sole destination is the LLM prompt. */
  systemPrompt: string;
  /** Tool-name allow-list. Validated when the agent was created. */
  allowedTools: string[];
  /** MCP-config allow-list. Empty = no MCP tools. */
  mcpConfigIds: string[];
  /** LLM model id. Allow-listed at agent creation. */
  model: string;
}

// ---------------------------------------------------------------------------
// Inbox entry + claim result
//
// These are the shapes the long-poll inbox stores and returns. `InboxEntry` is
// what producers queue; `ClaimResult` is what the long-poll claim resolves to.
//
// Cursor semantics (matches @ax/ipc-protocol SessionNextMessageResponseSchema):
//   - `user-message` / `cancel`: returned `cursor` is the NEXT cursor the
//     caller should request (delivered-index + 1).
//   - `timeout`: returned `cursor` echoes the input cursor (no advancement).
// ---------------------------------------------------------------------------

// `reqId` on `user-message` is the host-minted request id (J9). Producers
// that enqueue a user message (today: chat-orchestrator; later: the chat
// HTTP API in Task 9) MUST attach the reqId of the originating host
// request. The runner reads it back through `session:claim-work` and
// stamps it onto every `event.stream-chunk` so the host can route the
// chunk back to the waiting client (Task 5/7). REQUIRED — never optional.
export type InboxEntry =
  | { type: 'user-message'; payload: ChatMessage; reqId: string }
  | { type: 'cancel' };

export type ClaimResult =
  | { type: 'user-message'; payload: ChatMessage; reqId: string; cursor: number }
  | { type: 'cancel'; cursor: number }
  | { type: 'timeout'; cursor: number };

// ---------------------------------------------------------------------------
// Service hook I/O shapes
//
// Kept as plain interfaces — no Zod here. The IPC server validates wire
// payloads separately; in-process hook calls rely on TypeScript at compile
// time plus a small runtime shape-check inside the hook handlers.
// ---------------------------------------------------------------------------

export interface SessionCreateInput {
  sessionId: string;
  workspaceRoot: string;
  /**
   * Owner triple. Required for sessions minted via the Week-9.5
   * orchestrator path; pre-9.5 callers (test harnesses, future ad-hoc
   * tools) MAY omit it, in which case the session record stores nulls
   * and `session:get-config` will reject. The orchestrator is the only
   * production caller that mints sessions and it always sets this
   * field, so the optionality is purely for back-compat.
   *
   * Week 10–12 Task 15: `conversationId` ties this session to a persisted
   * conversation row so the runner can pull history at boot. Optional —
   * canary acceptance probes and ephemeral admin sessions don't have a
   * conversation, and the runner skips replay when null.
   */
  owner?: {
    userId: string;
    agentId: string;
    agentConfig: AgentConfig;
    conversationId?: string | null;
  };
}

export interface SessionCreateOutput {
  sessionId: string;
  token: string;
}

export interface SessionResolveTokenInput {
  token: string;
}

/**
 * `userId` and `agentId` are present once the session was minted with an
 * owner (Week 9.5+). Pre-9.5 sessions store nulls. Callers branch on the
 * null case — typically rejecting with an `owner-missing` error in the
 * security-sensitive path (e.g. Task 7's per-agent tool filter).
 *
 * Week 10–12 final review: `conversationId` rides on the resolve result so
 * the IPC server can stamp it onto every per-request ChatContext. Without
 * it, runner-fired `chat:turn-end` events lose their conversation binding
 * and three subscribers silently no-op (auto-append, clearActiveReqId,
 * SSE done-frame). Null for canary / admin sessions.
 */
export type SessionResolveTokenOutput =
  | {
      sessionId: string;
      workspaceRoot: string;
      userId: string | null;
      agentId: string | null;
      conversationId: string | null;
    }
  | null;

// ---------------------------------------------------------------------------
// session:get-config — host RPC the runner calls at boot to fetch its
// frozen agent config. Input is empty (the calling sessionId rides on
// ctx, set by the IPC server during token resolution); output mirrors
// the resolved agent's runner-relevant fields.
//
// Errors: `unknown-session` (sessionId on ctx didn't resolve) or
// `owner-missing` (the session has no agent — pre-9.5 record).
// ---------------------------------------------------------------------------

export type SessionGetConfigInput = Record<string, never>;

export interface SessionGetConfigOutput {
  userId: string;
  agentId: string;
  agentConfig: AgentConfig;
  /**
   * Conversation this session is bound to (Task 15 of Week 10–12). Null
   * for non-conversation sessions; the runner uses non-null as the
   * trigger to call `conversation.fetch-history` at boot.
   */
  conversationId: string | null;
}

export interface SessionQueueWorkInput {
  sessionId: string;
  entry: InboxEntry;
}

export interface SessionQueueWorkOutput {
  cursor: number;
}

export interface SessionClaimWorkInput {
  sessionId: string;
  cursor: number;
  timeoutMs: number;
}

export type SessionClaimWorkOutput = ClaimResult;

export interface SessionTerminateInput {
  sessionId: string;
}

// Empty-object return — idempotent terminate. `Record<string, never>` (rather
// than bare `{}`) is the TS idiom for "no properties allowed"; the bus's return
// shape stays explicit so a future widening is an intentional type change.
export type SessionTerminateOutput = Record<string, never>;

// ---------------------------------------------------------------------------
// session:is-alive — host-internal liveness probe (Week 10–12 Task 16, J6).
//
// The chat-orchestrator calls this to decide whether a conversation's
// `active_session_id` still points at a live sandbox (route the user
// message into its inbox) or a torn-down one (open a fresh sandbox). True
// IFF the session row exists AND has not been terminated. A nonexistent
// sessionId returns `false` rather than throwing — the caller's response
// to "you tried to write to a dead session" and "you tried to write to a
// session that was never minted" is the same: open a fresh one.
// ---------------------------------------------------------------------------
export interface SessionIsAliveInput {
  sessionId: string;
}
export interface SessionIsAliveOutput {
  alive: boolean;
}
