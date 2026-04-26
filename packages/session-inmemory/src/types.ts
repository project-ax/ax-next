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

export type InboxEntry =
  | { type: 'user-message'; payload: ChatMessage }
  | { type: 'cancel' };

export type ClaimResult =
  | { type: 'user-message'; payload: ChatMessage; cursor: number }
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
   */
  owner?: {
    userId: string;
    agentId: string;
    agentConfig: AgentConfig;
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
 */
export type SessionResolveTokenOutput =
  | {
      sessionId: string;
      workspaceRoot: string;
      userId: string | null;
      agentId: string | null;
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
