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
 * validateNewAttachments (missing/orphan bindings + malformed-slot rejection;
 * two skills sharing a slot name coexist via per-skill credential namespacing).
 */
export interface SkillAttachment {
  skillId: string;
  credentialBindings: Record<string /* slot */, string /* credential ref */>;
}

/**
 * The runner binaries the host knows how to spawn, by ID. PR 2 of the
 * provider-agnostic runner sequence
 * (docs/plans/2026-08-18-provider-agnostic-runner-design.md §1).
 *
 * An ID, never a path: the id → binary-path mapping lives in host config
 * (`ChatOrchestratorConfig.runnerBinaries`) and only reaches the wire on
 * `sandbox:open-session.runnerBinary`, which already carried an absolute
 * path. Nothing filesystem-shaped leaks into an agent row or a hook payload
 * (Invariant I1).
 *
 * Both ids are selectable as of PR 3, which shipped the `'aisdk'` binary
 * (@ax/agent-aisdk-runner) — see `SUPPORTED_RUNNERS` in store.ts, the
 * allow-list validation actually enforces.
 */
export type RunnerId = 'claude-sdk' | 'aisdk';

export interface Agent {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  visibility: 'personal' | 'team';
  displayName: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  /** Which runner binary the host spawns for this agent. An id, not a path. */
  runner: RunnerId;
  workspaceRef: string | null;
  skillAttachments: SkillAttachment[];
  /**
   * TASK-107 — the connector ids this agent is attached to. A first-class
   * per-agent connector-attachment store replacing the TASK-98 stopgap that
   * overloaded `mcpConfigIds`. A plain list of opaque connector-id slugs (no
   * credential bindings — a connector owns its own slots; the credential ref
   * derives from keyMode→scope, TASK-96). Written only via
   * agents:attach-connector / agents:detach-connector (one id per call), never
   * agents:create / agents:update. Empty/absent ⟹ no attached connectors.
   * The orchestrator resolves each via connectors:resolve into sandbox reach.
   */
  connectorAttachments: string[];
  /**
   * TASK-739 — connector ids the owner removed from this agent although they
   * reach it by another source (a legacy owned connector; TASK-808 retired
   * connector defaults, converting each into attachments except where an
   * exclusion said it was not wanted). The
   * effective-connector union skips every id here in ALL sources. Opaque
   * connector-id slugs. Written only by agents:attach-connector (removes) and
   * agents:detach-connector with `exclude: true` (adds).
   */
  connectorExclusions: string[];
  /**
   * Set only on the record `agents:resolve` returns, when the admin has since
   * removed this agent's stored model: `model` is then the Default and this is
   * what the owner originally chose. Never persisted.
   */
  requestedModel?: string;

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
  // There is no `systemPrompt` field (TASK-142). An agent's identity, soul and
  // its people's Instructions are this plugin's identity rows, read and
  // written only through `agents:identity:get|set` (TASK-989; Invariant #4).
  // A new agent is created bare; its identity is authored in its first-run
  // conversation, by the agent itself (`update_identity`) or in the admin
  // identity editor, and its Instructions on its settings page.
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  /**
   * Runner id. Optional on create — the runner follows the model's provider.
   * Typed `string` (not `RunnerId`) because the value arrives off the HTTP /
   * IPC wire unnarrowed; `validateRunner` rejects anything not in
   * `SUPPORTED_RUNNERS`.
   */
  runner?: string;
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
  allowedTools: z.array(z.string()),
  mcpConfigIds: z.array(z.string()),
  model: z.string(),
  // Declared explicitly: this schema is the `returns` contract on
  // `agents:resolve` and a zod object STRIPS undeclared keys — omitting
  // `runner` would silently drop it before the orchestrator ever sees it.
  // Mirrors the `RunnerId` union (same posture as ownerType / visibility:
  // a value outside the union is a corrupt row, not a new runner).
  runner: z.union([z.literal('claude-sdk'), z.literal('aisdk')]),
  workspaceRef: z.string().nullable(),
  skillAttachments: z.array(SkillAttachmentSchema),
  connectorAttachments: z.array(z.string()),
  // TASK-739 — declared for the same strip reason as `runner` below.
  connectorExclusions: z.array(z.string()),
  // Declared explicitly for the same reason as `runner`: a zod object strips
  // undeclared keys, and this schema is the `returns` contract of agents:resolve.
  requestedModel: z.string().optional(),

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
  /**
   * TASK-989 — the agent's onboarding state at birth. `'pending'` starts a
   * first-run setup: the agent's first conversations run its bootstrap script
   * until it calls `complete_bootstrap`. Only the conversational "create an
   * agent by talking to it" route passes it; absent or `'none'` means no
   * setup (the Default Agent, admin-created agents). Any other value is
   * `invalid-payload`, refused before anything is written.
   *
   * Top level, NOT on `AgentInput`, so `agents:update` and the admin routes'
   * strict bodies cannot set it. Written in the same transaction as the agent
   * row (the caller's `tx` when given), so the agent never exists without it.
   */
  bootstrap?: CreateBootstrap;
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

// --- agents:attach-connector / agents:detach-connector (TASK-739) -----------
//
// Single-connector edits, each ONE row-locked read-modify-write so two
// concurrent edits of the same agent never lose a write. These two hooks are
// the ONLY write path for `connectorAttachments` (TASK-799). ACL (TASK-765,
// widened by TASK-798): the agent's owner (a personal agent) / a team admin (a
// team agent) / a workspace admin — the same answer
// agents:can-manage-connectors gives. A plain team member may not attach
// or detach anything: whatever a team agent reaches, every member's runs reach.
// TASK-827 — there is no keyMode guard on attach: a shared-key (workspace)
// connector is one anyone may add to their own agent. Attaching grants no read
// of the shared key by itself; @ax/connectors decides that at read time
// (`credentials:authorize-global:account`, TASK-697: an admin-owned shared
// definition only).
//
// `changed` is false when the call was a no-op (already attached / already
// absent and not newly excluded). `exclude` records the id in
// `connectorExclusions` so a connector that reaches the agent by another
// source (a legacy-owned connector) stays removed.

export interface AttachConnectorInput {
  actor: Actor;
  agentId: string;
  connectorId: string;
}

export interface AttachConnectorOutput {
  agent: Agent;
  changed: boolean;
}

export interface DetachConnectorInput {
  actor: Actor;
  agentId: string;
  connectorId: string;
  exclude: boolean;
}

export interface DetachConnectorOutput {
  agent: Agent;
  changed: boolean;
}

// --- agents:can-manage-connectors (TASK-765, renamed TASK-803) ---------------
//
// Can `actor` change this agent's connectors — attach, detach, exclude a
// legacy-owned connector? (Signing in ON the agent was asked here from TASK-798
// until TASK-813 moved it to agents:can-set-shared-credential, below.) The
// same predicate `agents:attach-connector` / `agents:detach-connector`
// enforce, exposed so a caller can show the affordance only to someone it
// will work for. (TASK-803: renamed from its TASK-765 name, which was about
// exclusions only, once the question grew to this.) `allowed` is `false` —
// not an error — for an actor who cannot reach the agent at all, and that is
// the ONLY way this hook says no. A rejection is a fault, not a denial: a
// caller fails closed on it but must not report it to the person as
// "forbidden". `not-found` when the agent does not exist.

export interface CanManageConnectorsInput {
  actor: Actor;
  agentId: string;
}

export interface CanManageConnectorsOutput {
  allowed: boolean;
}

// --- agents:can-set-shared-credential (TASK-813) -----------------------------
//
// May `actor` choose the SHARED credential stored on this agent — start an
// OAuth sign-in ON it (@ax/mcp-oauth) or save an agent-scope ("team") key?
// The sign-in or key stored on a team agent is the account every member's runs
// act as, so choosing it belongs to the team's admins: `allowed` iff the agent
// is a team agent, the actor can reach it, and teams:is-member says they are a
// member with role `admin`. `actor.isAdmin` is IGNORED — a workspace admin who
// is not a team admin gets `false` (unlike agents:can-manage-connectors). A
// personal agent is always `false`: it has no shared credential (its sign-in or
// key is stored on the person). A missing teams plugin is `false`; any other
// lookup fault rejects, and callers treat a rejection as "no" (fail closed).
// `not-found` when the agent does not exist.

export interface CanSetSharedCredentialInput {
  actor: Actor;
  agentId: string;
}

export interface CanSetSharedCredentialOutput {
  allowed: boolean;
}

// --- agents:identity:get | set | complete-bootstrap (TASK-989) ---------------
//
// An agent's identity (who it is: name, emoji, vibe), its soul (its values and
// boundaries), its people's Instructions (standing instructions only people
// write) and its onboarding state. This plugin is the only store of them
// (Invariant #4); nothing reads a file for them any more.
//
// Every write goes through `agents:identity:set`, which normalises each
// section (trailing whitespace trimmed), caps the Instructions, runs each
// non-empty section through `identity:scan` (FAIL CLOSED: a missing scanner,
// a throw or any answer but `{ verdict: 'clean' }` refuses the whole patch —
// `content` for a `refused` verdict, `scan-unavailable` for everything else)
// and compare-and-sets on `revision`. A saved write and a completed first-run
// setup fire `system-prompt:augment-changed { agentId }` so live sessions
// rebuild their prompt at their next turn. A write says who made it
// (`author`, TASK-990): only the agent's own saves are listed on its owner's
// Today.
//
// ACL on all three: `input.agentId` must equal `ctx.agentId`, and `ctx.userId`
// must reach the agent (`checkAccess`: the personal owner, or a member of the
// owning team). Malformed input is `invalid-payload`, an unknown agent
// `not-found`, an unreachable one `forbidden`; every other answer is an
// outcome, never a throw, so callers map it without parsing error text.
//
// Storage-agnostic: `revision` is an opaque change counter (callers only hand
// it back as `expectedRevision`), not a version id; no field names a file,
// path, row or column. The alternate impl is a team-level profile service.

export const AGENTS_IDENTITY_GET_HOOK = 'agents:identity:get';
export const AGENTS_IDENTITY_SET_HOOK = 'agents:identity:set';
export const AGENTS_IDENTITY_COMPLETE_BOOTSTRAP_HOOK = 'agents:identity:complete-bootstrap';
/** Registered by @ax/validator-identity; called once per non-empty section of a write. */
export const IDENTITY_SCAN_HOOK = 'identity:scan';

/**
 * The `identity:scan` payload, re-declared here (no cross-plugin import).
 * `kind: 'instructions'` for people's Instructions; absent (the scanner's
 * default, `self-description`) for the identity and the soul.
 */
export interface IdentityScanPayload {
  text: string;
  kind?: 'self-description' | 'instructions';
}

/** The three texts, in the fixed order a write scans them. */
export const IDENTITY_SECTIONS = ['identity', 'soul', 'instructions'] as const;
export type IdentitySection = (typeof IDENTITY_SECTIONS)[number];

/**
 * `none`: never in a first-run setup. `pending`: in one (set only at create by
 * the conversational route). `done`: finished it (`complete-bootstrap`, a
 * one-way compare-and-set — nothing sets `pending` again).
 */
export type BootstrapState = 'none' | 'pending' | 'done';

/** The Instructions' cap, in JS string length (as memory's Rules had). */
export const INSTRUCTIONS_MAX_CHARS = 16_384;

export interface AgentIdentityRecord {
  identity: string;
  soul: string;
  instructions: string;
  bootstrap: BootstrapState;
  /** Change counter: +1 on every saved write and completed setup. Opaque. */
  revision: number;
}

export interface IdentityGetInput {
  agentId: string;
}

/** An agent with nothing saved reads as empty texts, `none`, revision 0. */
export type IdentityGetOutput = AgentIdentityRecord;

/**
 * Who is writing (TASK-990). `'agent'` is the agent changing itself, and only
 * its own `update_identity` tool says so; every other writer (the identity
 * editor, the Instructions editor) is a `'person'`.
 *
 * Boundary review: a team-level profile service would need the same field, to
 * tell people when a profile changed itself. No backend vocabulary; no
 * subscriber sees it (`system-prompt:augment-changed` is unchanged). Not an
 * IPC action: the sandbox reaches `agents:identity:set` only through
 * `tool:execute:update_identity`, which refuses extra input keys and sends
 * `'agent'` itself.
 */
export type IdentityAuthor = 'agent' | 'person';

export interface IdentitySetInput {
  agentId: string;
  /** At least one section. A section set to '' (or whitespace) is cleared. */
  patch: Partial<Record<IdentitySection, string>>;
  /** The `revision` this write was based on; a non-negative safe integer. */
  expectedRevision: number;
  /**
   * Who is writing. Absent = 'person'. Only the agent's own update_identity
   * sends 'agent'; an 'agent' patch may name only identity and soul. An
   * agent's saved change, outside its first-run setup, marks each section it
   * changed, and its owner's Today lists it
   * (`agents:identity:self-changes-for-user`).
   */
  author?: IdentityAuthor;
}

/**
 * Why a write was refused: `too-long` (Instructions over the cap), `content`
 * (the scan refused it), `scan-unavailable` (the scan is missing, threw or
 * answered neither `clean` nor `refused`, so nothing could be checked or
 * saved).
 */
export type IdentityRefusalCode = 'too-long' | 'content' | 'scan-unavailable';

/**
 * `saved`: the patch landed (revision bumped, change announced). `unchanged`:
 * every patched section already said that. `conflict`: `expectedRevision` is
 * stale; `record` is the current one to rebase on. `refused`: nothing was
 * saved; `section` is the first section that failed, `reason` a short
 * sentence safe to show a person or the agent.
 */
export type IdentitySetOutput =
  | { outcome: 'saved' | 'unchanged' | 'conflict'; record: AgentIdentityRecord }
  | { outcome: 'refused'; section: IdentitySection; code: IdentityRefusalCode; reason: string };

export interface IdentityCompleteBootstrapInput {
  agentId: string;
}

/**
 * `completed`: this call moved `pending → done` (exactly one caller ever
 * gets it). `already-done`: an earlier call did. `not-pending`: the agent was
 * never in a first-run setup. `needs-identity-and-soul`: still pending, but
 * the identity or the soul is empty. `record` is the current one.
 */
export interface IdentityCompleteBootstrapOutput {
  outcome: 'completed' | 'already-done' | 'not-pending' | 'needs-identity-and-soul';
  record: AgentIdentityRecord;
}

/** The onboarding states `agents:create` accepts. */
export type CreateBootstrap = 'none' | 'pending';

// Runtime `returns` contracts for the three hooks. Field names mirror the
// interfaces above; `return-schemas.test.ts` is the drift guard.
const AgentIdentityRecordObject = z.object({
  identity: z.string(),
  soul: z.string(),
  instructions: z.string(),
  bootstrap: z.enum(['none', 'pending', 'done']),
  revision: z.number().int().nonnegative(),
});

export const AgentIdentityRecordSchema: ZodType<AgentIdentityRecord> = AgentIdentityRecordObject;

export const IdentityGetOutputSchema: ZodType<IdentityGetOutput> = AgentIdentityRecordObject;

export const IdentitySetOutputSchema: ZodType<IdentitySetOutput> = z.union([
  z.object({
    outcome: z.enum(['saved', 'unchanged', 'conflict']),
    record: AgentIdentityRecordObject,
  }),
  z.object({
    outcome: z.literal('refused'),
    section: z.enum(IDENTITY_SECTIONS),
    code: z.enum(['too-long', 'content', 'scan-unavailable']),
    reason: z.string(),
  }),
]);

export const IdentityCompleteBootstrapOutputSchema: ZodType<IdentityCompleteBootstrapOutput> =
  z.object({
    outcome: z.enum(['completed', 'already-done', 'not-pending', 'needs-identity-and-soul']),
    record: AgentIdentityRecordObject,
  });

// --- agents:identity:self-changes-for-user (TASK-990) -------------------------
//
// The changes a person's own agents made to themselves, for Today: for each of
// the person's PERSONAL agents, the last time the agent itself changed its
// identity or its soul, outside its first-run setup. Only the agent's own
// `update_identity` tool writes such a change (an `agents:identity:set` with
// `author: 'agent'`); a person's editor save never does. channel-web words
// each item itself, keyed by `section` ("changed its personality"), and never
// counts one as waiting on anyone.
//
// Contract:
//   - Input is exactly `{ userId }`, a non-empty string; anything else is
//     `invalid-payload`. Like `agents:list-for-user`, the caller supplies the
//     person: the hook is host-only, and its one caller (channel-web) passes
//     the authenticated id. There is no ctx ACL.
//   - Personal agents the person owns, only. Team agents are left out until
//     the team role model says who answers for a shared persona.
//   - A section's change is listed only inside SELF_CHANGE_WINDOW_DAYS, on the
//     database clock and per section. At most one item per (agent, section):
//     the newest. Ordered newest first, then by agentId, then by section.
//   - An item is exactly { agentId, section, changedAt }. No text — identity,
//     soul, Instructions or anything the agent wrote — is stored for an item,
//     or sent with one.
//
// Boundary review:
//   - Alternate impl: a notifications/inbox service that stores agent-authored
//     events, or a team-level profile service.
//   - Leaky names: none. `section` is the identity vocabulary, `changedAt` an
//     ISO 8601 instant; no table, column or row id appears.
//   - Subscriber risk: none (a service hook).
//   - Wire surface: none. Host-only, not an IPC action.

export const AGENTS_IDENTITY_SELF_CHANGES_FOR_USER_HOOK = 'agents:identity:self-changes-for-user';

/** What an agent may change about itself: never its people's Instructions. */
export const SELF_SECTIONS = ['identity', 'soul'] as const;
export type SelfSection = (typeof SELF_SECTIONS)[number];

/** How many days an agent's change to itself stays listed (database clock). */
export const SELF_CHANGE_WINDOW_DAYS = 7;

export interface IdentitySelfChange {
  agentId: string;
  section: SelfSection;
  /** When the agent last changed this section: an ISO 8601 instant. */
  changedAt: string;
}

export interface IdentitySelfChangesForUserInput {
  userId: string;
}

export interface IdentitySelfChangesForUserOutput {
  changes: IdentitySelfChange[];
}

export const IdentitySelfChangesForUserOutputSchema: ZodType<IdentitySelfChangesForUserOutput> = z.object({
  changes: z.array(
    z.object({
      agentId: z.string().min(1),
      section: z.enum(SELF_SECTIONS),
      changedAt: z.string().datetime(),
    }),
  ),
});

// --- Subscriber payloads -----------------------------------------------------

/**
 * FIRED by `agents:resolve` after a successful ACL check. Generic-only:
 * subscribers see ids and visibility, NEVER the tool lists or other
 * sensitive per-tenant fields. Audit observers in Week 10-12 will
 * subscribe to this.
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

/**
 * FIRED by `agents:delete` AFTER the agent row is removed, so subscribers can
 * reclaim per-agent state owned in OTHER tiers. The first subscriber is the
 * sandbox provider's user-files cleanup (filestore-user-files design §11):
 * `rm -rf` of the agent's durable `/workspace` subtree (`subPath=<agentId>`)
 * via a short-lived mount-and-rm job.
 *
 * Payload mirrors `AgentsCreatedEvent` — minimal and storage-agnostic (L4 /
 * invariant I1): `agentId` is the per-agent subtree key a subscriber needs;
 * `ownerId`/`ownerType` let a subscriber scope its work without re-resolving
 * (the row is already gone, so `agents:resolve` would 404). NO filesystem /
 * NFS / k8s vocabulary leaks here — a subscriber that owns per-agent state
 * realizes the cleanup in its own backend's terms.
 *
 * Subscriber failures must not affect the delete — it already committed, and
 * `HookBus.fire` isolates each subscriber's errors. A subscriber that does
 * destructive work (the user-files cleanup) MUST scope it to EXACTLY this
 * `agentId`'s subtree and never touch a sibling agent's (cross-tenant safety,
 * design §9).
 */
export interface AgentsDeletedEvent {
  agentId: string;
  ownerId: string;
  ownerType: 'user' | 'team';
}

// --- agents:list-authored-skills ---------------------------------------------

/**
 * An agent-authored skill, returned by `agents:list-authored-skills` for the
 * human-reviewed promote UI.
 *
 * TASK-100 — a skill manifest can no longer declare capabilities: the parser
 * REJECTS any capabilities block, so a cap-bearing draft never parses and is
 * skipped. `hasForbiddenCapabilities` is therefore always `false` (kept for the
 * promote UI's gate, which can no longer trip). A skill's reach is the
 * `connectors` it references, carried here so a promoted skill preserves them.
 */
export interface AuthoredSkillSummary {
  id: string;
  description: string;
  version: number;
  bodyMd: string;
  /** The connector ids this skill references (TASK-92). Preserved on promote. */
  connectors: string[];
  /** @deprecated TASK-100 — always false (a skill can't declare capabilities). */
  hasForbiddenCapabilities: boolean;
}

export interface AgentsListAuthoredSkillsInput {
  agentId: string;
}

export interface AgentsListAuthoredSkillsOutput {
  skills: AuthoredSkillSummary[];
}

// --- agents:resolve-authored-skills (Phase 4) --------------------------------
//
// Returns the agent's self-authored drafts in the resolved-skill projection
// shape, projecting only the human-approved subset of the frontmatter
// capability proposal. No @ax/skills import (invariant #2) — the shape is
// defined structurally here.

/** Resolved-skill projection shape (structurally mirrors the orchestrator's
 * ResolvedSkillForOrch — NOT an @ax/skills import, per invariant #2).
 *
 * TASK-100 — a skill carries no capability block; its only declared reach is the
 * `connectors` it references (resolved into sandbox caps by the orchestrator's
 * skill→connector bridge). A model-authored skill is therefore always zero-
 * reach instruction scaffolding — there is no per-skill capability proposal or
 * delta, and so no per-skill capability approval card (a connector's reach is
 * gated instead by the held `connector_propose` call plus an admin creating the
 * connector). `manifestYaml` is the authored
 * SKILL.md verbatim (already cap-free — the parser rejects a capabilities
 * block). */
export interface AuthoredResolvedSkill {
  id: string;
  description: string;
  /** The connector ids this authored skill references (TASK-92). A NAME only —
   * a pending/unapproved connector grants ZERO reach (connectors:resolve reads
   * the live human-approved/curated table). */
  connectors: string[];
  bodyMd: string;
  manifestYaml: string;
  files: Array<{ path: string; contents: string }>;
  /** The gate verdict (TASK-76, §D3). `quarantined` is already omitted upstream;
   * the orchestrator consumes this to MATERIALIZE only `active` skills' bytes
   * into the spawn (a `pending` skill projects nothing until a human action
   * flips it to `active`). */
  status: 'active' | 'pending';
}

export interface AgentsResolveAuthoredSkillsInput {
  ownerUserId: string;
  agentId: string;
}

export interface AgentsResolveAuthoredSkillsOutput {
  skills: AuthoredResolvedSkill[];
}

export const AgentsResolveAuthoredSkillsOutputSchema = z.object({
  skills: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      connectors: z.array(z.string()),
      bodyMd: z.string(),
      manifestYaml: z.string(),
      files: z.array(z.object({ path: z.string(), contents: z.string() })),
      status: z.union([z.literal('active'), z.literal('pending')]),
    }),
  ),
}) as unknown as ZodType<AgentsResolveAuthoredSkillsOutput>;

// --- Plugin config -----------------------------------------------------------

export interface AgentsConfig {
  /**
   * Allow-list of LLM model identifiers. Empty falls back to
   * `AX_AGENT_MODELS_ALLOWED` env (comma-separated) or a built-in
   * default of three Claude IDs. Enforced at create/update time.
   */
  allowedModels?: readonly string[];
  /**
   * How long `agents:delete` waits on ONE `agents:deleted` subscriber before it
   * stops waiting and lets the next one run (TASK-718). Default
   * `AGENTS_DELETED_SUBSCRIBER_TIMEOUT_MS`. A timed-out subscriber is not killed
   * -- it gets an aborted `signal` and keeps whatever it was doing -- it just no
   * longer holds the delete, or the subscribers after it, hostage. Tests shrink
   * it; production has no reason to.
   */
  deletedSubscriberTimeoutMs?: number;
}

export const CanManageRoutinesInputSchema = z.object({ agentId: z.string().min(1).max(256) }).strict();
/** Membership permits one's own routines; only a current team admin may stop another member's work. */
export const CanManageRoutinesOutputSchema = z.object({ allowed: z.boolean(), stopOthers: z.boolean() }).strict();
export type CanManageRoutinesInput = z.infer<typeof CanManageRoutinesInputSchema>;
export type CanManageRoutinesOutput = z.infer<typeof CanManageRoutinesOutputSchema>;
