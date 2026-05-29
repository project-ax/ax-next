/**
 * @ax/agents public hook payload types.
 *
 * These shapes are the inter-plugin API. A future @ax/agents-git that
 * stores agent definitions as files in a repo would register the same
 * `agents:*` service hooks with these exact payload types — no field
 * here mentions postgres, ULIDs, or rows. `workspaceRef` is opaque to
 * subscribers; only the registering plugin's ACL gate parses it.
 */
import { z, type ZodType } from 'zod';
import type { Transaction } from 'kysely';

/**
 * A single installed skill attached to an agent, with its credential slot
 * bindings. `credentialBindings` maps each slot name declared by the skill
 * to the credential ref (opaque string) the agent uses to satisfy it.
 *
 * Written exclusively via PATCH /admin/agents/:id/skill-attachments — never
 * via agents:create or agents:update. Validated at attach-time by
 * validateNewAttachments (slot-collision detection, missing/orphan bindings).
 */
export interface SkillAttachment {
  skillId: string;
  credentialBindings: Record<string /* slot */, string /* credential ref */>;
}

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
  skillAttachments: SkillAttachment[];
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

// ---------------------------------------------------------------------------
// Runtime `returns` contract for `agents:resolve` (ARCH-6).
//
// `agents:resolve` is the J1 tenant ACL gate every `conversations:*` hook
// chains through, so its return shape is security-relevant: a malformed agent
// flowing out (e.g. a null `ownerId` or a non-array `allowedTools`) would
// silently widen what a caller trusts. The HookBus validates the handler's
// return against this schema (defense-in-depth alongside the store's own
// row shaping).
//
// Storage-agnostic by construction — the field names mirror the public `Agent`
// interface (no `pg_`, `row_id`, etc.). `createdAt`/`updatedAt` are real `Date`
// instances (`z.date()`, NOT `z.string()` — `z.string()` would reject a Date
// and the handler returns Dates from the store). `workspaceRef` is the opaque
// version token (I1) — validated as a nullable string, never resolved.
//
// Cast to `ZodType<ResolveOutput>`: zod's `.nullable()`/`.optional()` infer
// `| undefined`/`| null` shapes that `exactOptionalPropertyTypes` won't prove
// assignable to the interface. `return-schemas.test.ts` is the drift guard.
// ---------------------------------------------------------------------------
const SkillAttachmentSchema = z.object({
  skillId: z.string(),
  credentialBindings: z.record(z.string()),
});

const AgentSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  ownerType: z.union([z.literal('user'), z.literal('team')]),
  visibility: z.union([z.literal('personal'), z.literal('team')]),
  displayName: z.string(),
  systemPrompt: z.string(),
  allowedTools: z.array(z.string()),
  mcpConfigIds: z.array(z.string()),
  model: z.string(),
  workspaceRef: z.string().nullable(),
  skillAttachments: z.array(SkillAttachmentSchema),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const ResolveOutputSchema = z.object({
  agent: AgentSchema,
}) as unknown as ZodType<ResolveOutput>;

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

/**
 * Personal-agent enumeration with owner ids. Returned to trusted
 * background loops (the @ax/routines defaults-materialize tick) that
 * need to write per-agent rows under the agent owner's identity rather
 * than a synthetic system actor — the rows feed `agents:resolve`'s ACL
 * gate, which has no concept of a system user.
 *
 * Team-owned agents are deliberately excluded: routing a default
 * routine fire under "the team" is a policy decision (which member's
 * identity carries the fire?) the kernel doesn't make. They'll be
 * surfaced separately once the policy lands.
 */
export type ListPersonalOwnersInput = Record<string, never>;
export interface ListPersonalOwnersOutput {
  agents: Array<{ agentId: string; ownerUserId: string }>;
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

/**
 * FIRED by `agents:create` after the new agent row commits successfully.
 * Payload is intentionally minimal and storage-agnostic (L4): callers that
 * need richer agent data must look it up via `agents:resolve`. Carries
 * `ownerType` so subscribers can distinguish user-owned from team-owned
 * agents without re-resolving.
 *
 * Subscriber failures must not block agent creation — `HookBus.fire`
 * already isolates errors per subscriber, but subscribers should also
 * try/catch their own work (L6).
 */
export interface AgentsCreatedEvent {
  agentId: string;
  ownerId: string;
  ownerType: 'user' | 'team';
}

// --- agents:list-authored-skills ---------------------------------------------

/**
 * A SKILL.md file found under `.ax/draft-skills/<id>/SKILL.md` in an agent's
 * workspace. Returned by `agents:list-authored-skills`.
 *
 * `hasForbiddenCapabilities` is true when the parsed manifest declares any
 * `allowedHosts`, `credentials`, or `mcpServers` entries. Agent-authored
 * files MUST NOT declare capabilities (half-trust: an agent cannot grant
 * itself external reach). We flag rather than drop so the promote UI can
 * explain what must change before the skill can be promoted.
 */
export interface AuthoredSkillSummary {
  id: string;
  description: string;
  version: number;
  bodyMd: string;
  hasForbiddenCapabilities: boolean;
}

export interface AgentsListAuthoredSkillsInput {
  agentId: string;
}

export interface AgentsListAuthoredSkillsOutput {
  skills: AuthoredSkillSummary[];
}

// --- agents:install-authored-skill (TASK-39, open-mode authoring) ------------
//
// Promote an agent-authored workspace draft (.ax/draft-skills/<id>/) into a USABLE
// USER-scoped skill carrying the user-REQUESTED capabilities, then retire the
// draft. The requested hosts/slots are surfaced on the approval card for the
// user to approve (design §6C/§10). Storage-agnostic: `hosts`/`slots` are
// public manifest data; no secret, no backend vocabulary. Alternate impl: a
// non-workspace authoring backend that accepts the bundle inline.
export interface AgentsInstallAuthoredSkillInput {
  agentId: string;
  skillId: string;
  /** Hostnames the skill needs to reach (user-approved on the card). */
  hosts: string[];
  /** Credential slot names the skill needs (user-approved on the card). */
  slots: string[];
  /** Package ecosystems the skill needs (user-approved on the card). Optional; default none. */
  packages?: { npm?: string[]; pypi?: string[] };
}
export interface AgentsInstallAuthoredSkillOutput {
  /** From the authored SKILL.md — shown on the card. */
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key' }[];
  packages: { npm: string[]; pypi: string[] };
}

export const AgentsInstallAuthoredSkillOutputSchema = z.object({
  description: z.string(),
  hosts: z.array(z.string()),
  slots: z.array(z.object({ slot: z.string(), kind: z.literal('api-key') })),
  packages: z.object({ npm: z.array(z.string()), pypi: z.array(z.string()) }),
}) as unknown as ZodType<AgentsInstallAuthoredSkillOutput>;

// --- Plugin config -----------------------------------------------------------

export interface AgentsConfig {
  /**
   * Allow-list of LLM model identifiers. Empty falls back to
   * `AX_AGENT_MODELS_ALLOWED` env (comma-separated) or a built-in
   * default of three Claude IDs. Enforced at create/update time.
   */
  allowedModels?: readonly string[];
}
