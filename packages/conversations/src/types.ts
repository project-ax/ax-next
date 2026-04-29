import type { ContentBlock } from '@ax/ipc-protocol';
import { ContentBlockSchema } from '@ax/ipc-protocol';

/**
 * @ax/conversations public types.
 *
 * Per Invariant I1, no field name in this file should ever encode a
 * particular backend (no `pg_`, `bucket_`, `sha`, `pod_name`, etc.). The
 * canonical alternate impl we keep in mind is `@ax/conversations-sqlite`
 * for single-replica dev.
 *
 * Hook payload shapes are the inter-plugin API. A future
 * `@ax/conversations-sqlite` would register the same `conversations:*`
 * service hooks with these exact shapes.
 */

// ---------------------------------------------------------------------------
// ContentBlock — single source of truth lives in @ax/ipc-protocol (I4).
//
// Both the IPC wire (event.turn-end) and our JSONB column carry the same
// shape, so the canonical zod schema lives in the one place both plugins
// already share. We re-export here so existing `@ax/conversations`
// consumers don't have to reach across packages for the type.
// ---------------------------------------------------------------------------
export { ContentBlockSchema };
export type { ContentBlock };

// ---------------------------------------------------------------------------
// Domain types — exposed on hook payloads.
// ---------------------------------------------------------------------------

export type TurnRole = 'user' | 'assistant' | 'tool';

export interface Turn {
  turnId: string;
  turnIndex: number;
  role: TurnRole;
  /**
   * Content blocks. Strongly typed at the package boundary; the store still
   * runtime-parses against `ContentBlockSchema` on read AND write so we
   * don't trust the DB blindly (Invariant I5 — capabilities-minimized,
   * untrusted-content-stays-untrusted).
   */
  contentBlocks: ContentBlock[];
  /** ISO-8601 string. */
  createdAt: string;
}

export interface Conversation {
  conversationId: string;
  userId: string;
  /** Frozen at create (Invariant I10). Never updated. */
  agentId: string;
  /** Nullable; MVP doesn't auto-generate. */
  title: string | null;
  /** Nullable; cleared in Task 14. */
  activeSessionId: string | null;
  /** Nullable; the in-flight reqId, if any (Invariant J7). */
  activeReqId: string | null;
  /**
   * Phase B (2026-04-29). Frozen at create-time from
   * `ConversationsConfig.defaultRunnerType`. Mirrors I10 (immutable for
   * the conversation's lifetime). Nullable for pre-Phase-B rows.
   */
  runnerType: string | null;
  /**
   * Phase B. The runner's native session id (e.g. SDK sessionId for
   * `@ax/agent-claude-sdk-runner`). Bound on the first turn via
   * `conversations:store-runner-session`. Null until then.
   */
  runnerSessionId: string | null;
  /**
   * Phase B. Frozen copy of `agent.workspaceRef` at conversation create.
   * Mirrors I10. Nullable when the agent had no workspaceRef OR the row
   * predates Phase B.
   */
  workspaceRef: string | null;
  /**
   * Phase B. ISO-8601 string. Bumped by the `chat:turn-end` subscriber
   * on every non-heartbeat turn. Opaque to correctness; sidebar ordering
   * only. Null for pre-Phase-B rows or rows that haven't seen a turn.
   */
  lastActivityAt: string | null;
  /** ISO-8601 string. */
  createdAt: string;
  /** ISO-8601 string. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Service hook payloads.
//
// Every hook is gated by a `agents:resolve(agentId, userId)` call BEFORE
// touching the store (Invariant J1). On `forbidden` / `not-found` from
// `agents:resolve` we propagate the matching `PluginError` code.
// ---------------------------------------------------------------------------

export interface CreateInput {
  userId: string;
  agentId: string;
  /** Optional title — MVP leaves it null. */
  title?: string | null;
}
export type CreateOutput = Conversation;

export interface AppendTurnInput {
  conversationId: string;
  /**
   * The user this turn belongs to. The `agents:resolve` gate uses this
   * to authorize the write against the conversation's frozen agent_id.
   */
  userId: string;
  role: TurnRole;
  contentBlocks: ContentBlock[];
}
export type AppendTurnOutput = Turn;

export interface GetInput {
  conversationId: string;
  userId: string;
  /**
   * Reserved for Task 21 thinking-block UI toggle (Invariant J4). The
   * store unconditionally returns whatever blocks were appended; this
   * flag is forwarded to consumers but does NOT filter at the hook
   * boundary.
   */
  includeThinking?: boolean;
}
export interface GetOutput {
  conversation: Conversation;
  turns: Turn[];
}

export interface ListInput {
  userId: string;
  /**
   * Optional filter — when set, only conversations under this agent are
   * returned. When absent, list returns every conversation the user
   * owns; ACL is implicit via `user_id` filter.
   */
  agentId?: string;
}
export type ListOutput = Conversation[];

export interface DeleteInput {
  conversationId: string;
  userId: string;
}
/** Soft delete (Invariant J5). No payload — caller sees void on success. */
export type DeleteOutput = void;

/**
 * Lookup a conversation by its in-flight `active_req_id`. Used by
 * channel-web's SSE handler (Week 10–12 Task 7, Invariant J9) so a
 * browser-supplied `:reqId` URL param can be authorized — callers MUST
 * own the row (filtered by `user_id`), and tombstones (`deleted_at IS
 * NULL`) are excluded.
 *
 * Throws `PluginError({ code: 'not-found' })` when no matching row
 * exists. The route layer maps that to 404 (NOT 403) — guessing a
 * foreign reqId leaks no signal beyond "no such stream."
 *
 * NOTE: this hook does NOT call `agents:resolve` (J1 gate). The caller
 * is expected to chain a follow-up `agents:resolve(agentId, userId)`
 * with the returned `agentId`. Two reasons:
 *
 *   1. The user already passes the `user_id` filter, so existence-leak
 *      is already prevented at this hook's boundary.
 *   2. Some callers (audit, debug probes) want the lookup without
 *      forcing the gate; making it explicit at the call site keeps
 *      the policy decision visible.
 */
export interface GetByReqIdInput {
  reqId: string;
  userId: string;
}
export type GetByReqIdOutput = Conversation;

/**
 * Bind a sandbox session + in-flight reqId to a conversation row. Sets
 * BOTH `active_session_id` AND `active_req_id` atomically (J6: one
 * sandbox session per conversation at a time).
 *
 * Caller is the chat-orchestrator (Task 16) which has already validated
 * the user via `agents:resolve` at `agent:invoke` entry. This hook does NOT
 * call `agents:resolve`, but it DOES scope the row by `(conversation_id,
 * user_id)` derived from `ctx.userId` — a misbehaving caller cannot bind
 * a cross-tenant row.
 *
 * On a row not matching `(conversation_id, ctx.userId)` (and not
 * tombstoned), throws `PluginError({ code: 'not-found' })`.
 */
export interface BindSessionInput {
  conversationId: string;
  sessionId: string;
  reqId: string;
}
export type BindSessionOutput = void;

/**
 * Clear `active_session_id` AND `active_req_id` on the conversation row.
 * Same `(conversation_id, ctx.userId)` scoping as `bind-session`. Throws
 * `PluginError({ code: 'not-found' })` on a row mismatch.
 *
 * The host-internal `session:terminate` subscriber takes a different
 * path (`store.clearBySessionId`) since it must clear ALL conversations
 * bound to a sessionId regardless of owner.
 */
export interface UnbindSessionInput {
  conversationId: string;
}
export type UnbindSessionOutput = void;

/**
 * Phase B (2026-04-29). Sidebar / runner-plugin metadata read. Returns
 * the projection only — `runner:read-transcript` ships separately
 * (Phase C) and returns the runner's native transcript bytes. Combining
 * both into one hook would re-create the lossy projection problem the
 * design solves (I6).
 *
 * ACL: same as `conversations:get` — `(conversation_id, user_id)`
 * pre-filter, then `agents:resolve(agent_id, user_id)`. A foreign row
 * looks identical to "no such row" from the caller's perspective.
 */
export interface GetMetadataInput {
  conversationId: string;
  userId: string;
}
export interface GetMetadataOutput {
  conversationId: string;
  userId: string;
  agentId: string;
  runnerType: string | null;
  runnerSessionId: string | null;
  workspaceRef: string | null;
  title: string | null;
  /** ISO-8601, or null if no turns yet / pre-Phase-B row. */
  lastActivityAt: string | null;
  /** ISO-8601. */
  createdAt: string;
}

/**
 * Phase B (2026-04-29). Bind the runner's native session id to a
 * conversation row exactly once. Called by the runner-plugin's host-side
 * IPC handler (Phase C) after the runner subprocess captures its
 * native session identifier on the first turn.
 *
 * Idempotent for re-binds to the same value (no-op success). Throws
 * `conflict` on a re-bind to a different value (I7) — that signals a
 * runner-side bug (two first-turn IPCs fired) AND prevents an orphan
 * native-session artifact on disk.
 *
 * ACL: `(conversation_id, ctx.userId)` UPDATE-scope only. No
 * `agents:resolve` round-trip — the host has already gated the user at
 * `agent:invoke` entry. A misbehaving caller cannot bind a cross-tenant
 * row because the UPDATE filter rejects mismatched user_id with the
 * uniform `not-found` shape.
 *
 * `runnerSessionId` is opaque at this layer — no field name leaks the
 * specific runner shape (no `sdk_session_id`, no `jsonl_path`). I9.
 */
export interface StoreRunnerSessionInput {
  conversationId: string;
  runnerSessionId: string;
}
export type StoreRunnerSessionOutput = void;

/**
 * Fetch the persisted turn history for a conversation, formatted for
 * runner replay (Week 10–12 Task 15, Invariant J3 + J6 resume).
 *
 * The output strips `turnId` / `turnIndex` / `createdAt` from the full
 * `Turn` shape — replay into the SDK's prompt iterator only needs role
 * + content blocks, and a smaller payload keeps the wire surface tight.
 *
 * ACL: same `(user_id, agent_id)` gate as `conversations:get` (J1). A
 * caller that doesn't own the row gets `PluginError({ code: 'not-found' })`
 * — the same not-found-instead-of-forbidden posture as elsewhere, so a
 * tenant-id guess leaks no signal.
 */
export interface FetchHistoryInput {
  conversationId: string;
  userId: string;
}
export interface FetchHistoryTurn {
  role: TurnRole;
  contentBlocks: ContentBlock[];
}
export interface FetchHistoryOutput {
  turns: FetchHistoryTurn[];
}

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

/**
 * Plugin config knobs. Postgres + kysely come from the
 * @ax/database-postgres service via the bus, not from this config.
 */
export interface ConversationsConfig {
  /**
   * Phase B (2026-04-29). The runner-plugin name to freeze onto every new
   * conversation row's `runner_type` column. Single-runner-per-host MVP
   * (design D5), so this is a constant the host preset declares — the
   * conversations plugin inherits it. Same string the runner plugin
   * itself reports; keep them in lockstep when a new runner ships. (When
   * the future `@ax/runner-router` plugin lands, dispatch moves there
   * and this knob becomes a default-not-required.)
   *
   * Validation regex `^[a-z0-9-]+$`, max 64 chars. Default `'claude-sdk'`.
   */
  defaultRunnerType?: string;
}
