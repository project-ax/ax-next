/**
 * @ax/agents public hook payload types.
 *
 * These shapes are the inter-plugin API. A future @ax/agents-git that
 * stores agent definitions as files in a repo would register the same
 * `agents:*` service hooks with these exact payload types — no field
 * here mentions postgres, ULIDs, or rows. `workspaceRef` is opaque to
 * subscribers; only the registering plugin's ACL gate parses it.
 */
import type { Transaction } from 'kysely';

export interface Agent {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  visibility: 'personal' | 'team';
  displayName: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  workspaceRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Caller-supplied shape on `agents:create` / fields settable on
 * `agents:update`. Fields validate independently — partial updates
 * validate only the present fields.
 *
 * `visibility === 'team'` REQUIRES `teamId`. `visibility === 'personal'`
 * MUST NOT carry `teamId`. The store enforces the pairing at insert
 * time; the DB CHECK constraint guarantees we cannot persist a row
 * where `owner_type` and `visibility` disagree.
 */
export interface AgentInput {
  displayName: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  workspaceRef?: string | null;
  visibility: 'personal' | 'team';
  /**
   * Required for `visibility === 'team'`; must be the team_id the caller
   * is a member of. The plugin checks membership via `teams:is-member`
   * (best-effort — denies if @ax/teams isn't loaded).
   */
  teamId?: string;
}

/**
 * Minimal actor shape — only the fields the agents plugin's authz logic
 * reads. Constructed by the admin endpoint handler from
 * `auth:require-user`'s output; tests construct it directly.
 */
export interface Actor {
  userId: string;
  isAdmin: boolean;
}

// --- Service hook payloads ---------------------------------------------------

export interface ResolveInput {
  agentId: string;
  userId: string;
}

export interface ResolveOutput {
  agent: Agent;
}

export interface ListForUserInput {
  userId: string;
  /**
   * Team ids the user is a member of. Required to surface team-visibility
   * agents. Callers with no teams pass `[]`. Out-of-band so this plugin
   * doesn't have to call `teams:list-for-user` itself (which would form
   * a hard manifest dep on @ax/teams).
   */
  teamIds?: string[];
}

export interface ListForUserOutput {
  agents: Agent[];
}

export interface CreateInput {
  actor: Actor;
  input: AgentInput;
  /** Optional transaction handle from db:transact's run callback. */
  tx?: Transaction<unknown>;
}

export interface CreateOutput {
  agent: Agent;
}

export interface UpdateInput {
  actor: Actor;
  agentId: string;
  patch: Partial<AgentInput>;
}

export interface UpdateOutput {
  agent: Agent;
}

export interface DeleteInput {
  actor: Actor;
  agentId: string;
}

export type DeleteOutput = void;

export interface ResolveByWebhookTokenInput {
  token: string;
}

/**
 * Null on miss. Deliberately no `PluginError` — callers map null → 404
 * and we avoid distinguishing "wrong token" from "no agent" (no
 * oracle).
 */
export type ResolveByWebhookTokenOutput = { agent: Agent } | null;

export interface RotateWebhookTokenInput {
  actor: Actor;
  agentId: string;
}

export interface RotateWebhookTokenOutput {
  token: string;
}

/**
 * Idempotent token access: returns the existing token if one is already set,
 * generates + stores + returns a fresh one if null. Same ACL as
 * `agents:rotate-webhook-token` (owner OR admin). Used by privileged
 * in-process callers (e.g., the routines sync subscriber) that need a stable
 * token without forcing a rotation.
 */
export interface EnsureWebhookTokenInput {
  actor: Actor;
  agentId: string;
}

export interface EnsureWebhookTokenOutput {
  token: string;
}

// --- Subscriber payloads -----------------------------------------------------

/**
 * FIRED by `agents:resolve` after a successful ACL check. Generic-only:
 * subscribers see ids and visibility, NEVER the system_prompt or tool
 * lists (those are sensitive and per-tenant). Audit observers in
 * Week 10-12 will subscribe to this.
 */
export interface AgentsResolvedEvent {
  agentId: string;
  userId: string;
  visibility: 'personal' | 'team';
}

/**
 * FIRED by `agents:rotate-webhook-token` after the new token is persisted.
 * Payload is intentionally opaque — only `agentId`, never the token itself.
 * Subscribers (e.g., @ax/routines) re-resolve the token via
 * `agents:ensure-webhook-token` so the agents plugin remains the single
 * source of truth.
 */
export interface AgentsWebhookTokenRotatedEvent {
  agentId: string;
}

// --- Plugin config -----------------------------------------------------------

export interface AgentsConfig {
  /**
   * Allow-list of LLM model identifiers. Empty falls back to
   * `AX_AGENT_MODELS_ALLOWED` env (comma-separated) or a built-in
   * default of three Claude IDs. Enforced at create/update time.
   */
  allowedModels?: readonly string[];
}
