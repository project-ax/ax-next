import { z } from 'zod';

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
// ContentBlock shim
//
// TODO(Task 4): replace shim with @ax/ipc-protocol ContentBlockSchema.
//
// Task 4 of the Week 10–12 plan locks the canonical Anthropic-compatible
// ContentBlock zod schema in @ax/ipc-protocol. Task 2 (this file) runs
// BEFORE Task 4 in plan ordering, so to avoid a cyclic dependency we
// define a permissive local shim. The runtime will provide the real
// shape; we just want a sanity check that the JSONB column holds an
// array of objects.
// ---------------------------------------------------------------------------
export const ContentBlockShim = z.array(z.record(z.string(), z.unknown()));
export type ContentBlock = z.infer<typeof ContentBlockShim>[number];

// ---------------------------------------------------------------------------
// Domain types — exposed on hook payloads.
// ---------------------------------------------------------------------------

export type TurnRole = 'user' | 'assistant' | 'tool';

export interface Turn {
  turnId: string;
  turnIndex: number;
  role: TurnRole;
  /** Content blocks. Shim until Task 4 (see above). */
  contentBlocks: unknown[];
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
  contentBlocks: unknown[];
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

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

// No config knobs in MVP — postgres + kysely come from the
// @ax/database-postgres service via the bus. Knobs may land alongside
// Task 14 (e.g. soft-delete retention window) but only if a second
// backend would also want them. We keep the type so the public surface
// is forward-compatible.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ConversationsConfig {}
