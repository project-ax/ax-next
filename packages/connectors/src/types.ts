import { z, type ZodType } from 'zod';
import type {
  Capabilities,
  McpServerSpec,
  PackagesSpec,
  ServiceDescriptor,
} from '@ax/skills-parser';
// Type-only import of the derived plan entry — no runtime cycle (types are
// erased; credential-plan.ts imports the domain types from here).
import type { CredentialPlanEntry } from './credential-plan.js';
import type { ToolNamespaceEntry } from './tool-namespace.js';

/**
 * @ax/connectors public types.
 *
 * Per Invariant I1, no field name in this file encodes a particular backend
 * (no `pg_`, `sha`, `bucket`, `pod_name`, …). The canonical alternate impl we
 * keep in mind is `@ax/connectors-sqlite` for single-replica dev — it would
 * register the same `connectors:*` service hooks with these exact shapes.
 *
 * Mechanism-agnostic by construction: a connector's BACKING mechanism (MCP
 * over http/stdio, a CLI package, a direct API) lives ONLY inside the
 * `Capabilities` spec (allowedHosts / credentials / mcpServers / packages).
 * The connector's own first-class fields — `keyMode` / `visibility` /
 * `usageNote` — are storage-agnostic, so no `transport` / `command` / `stdio`
 * / `url` / `mcp` ever appears as a first-class hook field. A subscriber keys
 * off the connector `id` + its declared `credentials` / `allowedHosts`, never
 * off "is this MCP?" — the backing mechanism can change without the connector's
 * identity changing.
 */

// ---------------------------------------------------------------------------
// Capabilities — single source of truth lives in @ax/skills-parser (I4).
//
// TASK-90 lifted the neutral `Capabilities` shape out of the skill manifest
// into the dependency-free `@ax/skills-parser` parser package precisely so a
// connector can reference the SAME shape WITHOUT a cross-plugin runtime import
// (Invariant I2 — type-only imports are allowed; runtime imports are not). We
// TYPE-import the interface and re-declare the zod validator LOCALLY below, so
// no runtime edge to @ax/skills-parser is created.
// ---------------------------------------------------------------------------
export type { Capabilities, McpServerSpec, PackagesSpec, ServiceDescriptor };

/**
 * An OAuth credential slot — `server` names the mcpServers[] entry whose
 * resource URL is the OAuth protected resource. Pinned client fields are
 * optional (DCR is the default path). No backend vocabulary: `.strict()` on
 * the zod schema rejects smuggled transport/command/url fields.
 */
export interface OAuthCapabilitySlot {
  slot: string;
  kind: 'oauth';
  server: string;
  scopes?: string[];
  clientId?: string;
  clientRegistration?: 'auto' | 'cimd' | 'dcr' | 'custom';
  clientSecretRef?: string;
  authServerUrl?: string;
  tokenUrl?: string;
}

/**
 * A credential slot declared inside a connector's Capabilities. Either an
 * API-key slot (back-compat with existing connectors) or an OAuth slot (new
 * for MCP connectors that use the OAuth authorization flow). Replaces the
 * @ax/skills-parser CapabilitySlot (which is api-key-only) for all
 * @ax/connectors consumers.
 */
export type CapabilitySlot =
  | { slot: string; kind: 'api-key'; description?: string; account?: string; headerName?: string; server?: string }
  | OAuthCapabilitySlot;

/**
 * Local zod validator for the type-imported {@link Capabilities} shape. The
 * connector store NEVER trusts the JSONB column blindly — it parses on write
 * AND on read (the same don't-trust-the-DB posture as @ax/conversations'
 * ContentBlock column). Re-declaring the schema here keeps it a TYPE-only
 * dependency on @ax/skills-parser (no runtime cross-plugin import).
 *
 * Cast to `ZodType<Capabilities>` (not `satisfies`): zod's `.optional()` infers
 * `field?: T | undefined`, which `exactOptionalPropertyTypes: true` won't prove
 * directly assignable to the interface's `field?: T`. The structure matches;
 * `capabilities-schema.test.ts` is the drift guard that re-validates a real
 * spec round-trips. (Same pattern as @ax/skills' return schemas.)
 */
// Each connector owns its own key(s): there is NO share-by-service `account`
// tag. A slot's vault ref is keyed by the connector id (see credential-plan.ts).
// `account` is deliberately ABSENT from the api-key schema, so a legacy `account`
// field on stored JSONB is STRIPPED on read (zod drops unknown keys on non-strict
// objects) — the read path can therefore never resurrect the old shared-key
// behaviour. NOTE: the api-key variant deliberately does NOT use `.strict()` to
// preserve that silent-strip behaviour for legacy `account` field on stored rows.
const ApiKeySlotSchema = z.object({
  slot: z.string(),
  kind: z.literal('api-key'),
  description: z.string().optional(),
  headerName: z.string().max(64).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
    .refine((name) => !['host', 'content-length', 'transfer-encoding', 'connection', 'cookie', 'set-cookie', 'proxy-authorization', 'proxy-connection', 'upgrade', 'trailer', 'te', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'].includes(name.toLowerCase()), 'This header is managed by the transport.').optional(),
  server: z.string().optional(),
});

// OAuth slot: `server` names the mcpServers[] entry whose `url` is the OAuth
// resource. Pinned client fields are optional (DCR is the default path). No
// backend vocabulary leaks — `.strict()` rejects smuggled transport/command/url.
const OAuthSlotSchema = z
  .object({
    slot: z.string(),
    kind: z.literal('oauth'),
    server: z.string(),
    scopes: z.array(z.string()).optional(),
    clientId: z.string().optional(),
    clientRegistration: z.enum(['auto', 'cimd', 'dcr', 'custom']).optional(),
    clientSecretRef: z.string().optional(),
    authServerUrl: z.string().url().optional(),
    tokenUrl: z.string().url().optional(),
  })
  .strict();

const CapabilitySlotSchema = z.discriminatedUnion('kind', [
  ApiKeySlotSchema,
  OAuthSlotSchema,
]);

const McpServerSpecSchema = z.object({
  name: z.string(),
  transport: z.union([z.literal('stdio'), z.literal('http')]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  allowedHosts: z.array(z.string()),
  credentials: z.array(CapabilitySlotSchema),
});

const PackagesSpecSchema = z.object({
  npm: z.array(z.string()),
  pypi: z.array(z.string()),
});

// TASK-150 — the neutral dev-service descriptor. Canonical shape lives in
// @ax/skills-parser (`ServiceDescriptorSchema`); re-declared LOCALLY here so the
// store's CapabilitiesSchema round-trips `services` while keeping the
// @ax/skills-parser import TYPE-only (I2 — same stance as the McpServerSpec
// re-declaration above). `.strict()` rejects smuggled backend vocabulary (I2);
// the digest-pin regex enforces I8. The store stores this verbatim; the wire
// (@ax/sandbox-protocol) and @ax/validator-service re-validate independently.
const ServicePortSchema = z.number().int().min(1).max(65535);
const HealthcheckSchema = z.union([
  z.object({ kind: z.literal('tcp'), port: ServicePortSchema }).strict(),
  z
    .object({
      kind: z.literal('exec'),
      command: z.array(z.string().max(256)).min(1).max(16),
    })
    .strict(),
]);
const ServiceDescriptorSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    image: z.string().regex(/.+@sha256:[0-9a-f]{64}$/),
    ports: z.array(ServicePortSchema).max(16),
    env: z.record(z.string().max(256), z.string().max(2048)).superRefine((rec, ctx) => {
      if (Object.keys(rec).length > 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `env may declare at most 32 entries, got ${Object.keys(rec).length}`,
        });
      }
    }),
    healthcheck: HealthcheckSchema.optional(),
    writablePaths: z.array(z.string().regex(/^\//).max(256)).max(16).default([]),
  })
  .strict();

export const CapabilitiesSchema = z.object({
  allowedHosts: z.array(z.string()),
  credentials: z.array(CapabilitySlotSchema),
  mcpServers: z.array(McpServerSpecSchema),
  packages: PackagesSpecSchema,
  // Optional on ingress (legacy rows + existing callers omit it); the schema
  // defaults it to `[]` so a parsed Capabilities always carries `services`.
  services: z.array(ServiceDescriptorSchema).max(8).default([]),
}) as unknown as ZodType<Capabilities>;

// ---------------------------------------------------------------------------
// Domain types — exposed on hook payloads.
// ---------------------------------------------------------------------------

/**
 * Whose key the connect flow uses (design "Connector keyMode"):
 *   - `personal`  — each user supplies their own key; everyone acts as
 *                   themselves (per-user data: my Gmail, my Drive).
 *   - `workspace` — an admin supplies ONE key; every allowed agent spends it
 *                   as a shared service identity (org-wide Salesforce).
 */
export type KeyMode = 'personal' | 'workspace';

/**
 * Whether a connector is private to its owner's agents or shared. Derived from
 * the owner/catalog model in the design; here it is a declared field on the
 * connector. Storage-agnostic.
 */
export type Visibility = 'private' | 'shared';

/**
 * The first-class Connector object: authenticated ACCESS to a data source,
 * mechanism hidden. `{ id, name, description, usageNote, keyMode, visibility }`
 * plus the neutral {@link Capabilities} spec.
 */
export interface Connector {
  /** Whether the requesting user owns this definition and may edit it. */
  canEdit?: boolean;
  /** Skip legacy implicit owner attachment; defaults and explicit attachments still apply. */
  requiresAttachment?: boolean;
  /** Stable connector identity (slug). Frozen for the connector's lifetime. */
  id: string;
  name: string;
  description: string;
  /**
   * Light "how to use me" blurb — mirrors how an MCP server self-describes its
   * tools, so connecting a service yields a working capability out of the box
   * (design decision option b). Empty string when none.
   */
  usageNote: string;
  keyMode: KeyMode;
  visibility: Visibility;
  /**
   * The mechanism-agnostic fill (allowedHosts / credentials / mcpServers /
   * packages). The ONLY place backing-mechanism vocabulary lives.
   */
  capabilities: Capabilities;
  /**
   * TASK-97 — workspace-default flag. When true this connector flows into every
   * agent's effective connector set (the orchestrator reads default-attached
   * connectors via `connectors:list-defaults`), mirroring a default-attached
   * skill. Storage-agnostic boolean.
   */
  defaultAttached: boolean;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
}

/**
 * Metadata-only descriptor for list views — omits the `capabilities` spec so a
 * list query stays cheap and the UI's mechanism detail stays behind "Advanced"
 * (it fetches the full connector via `connectors:get` on demand).
 */
export interface ConnectorSummary {
  /** Whether the requesting user owns this definition and may edit it. */
  canEdit?: boolean;
  /** Skip legacy implicit owner attachment; defaults and explicit attachments still apply. */
  requiresAttachment?: boolean;
  id: string;
  name: string;
  description: string;
  usageNote: string;
  keyMode: KeyMode;
  visibility: Visibility;
  /**
   * TASK-97/110 — the workspace-default flag, surfaced on the LIST shape too so
   * the user connector list can badge an admin default-on connector as "Catalog"
   * even when its `visibility` is `private` (the badge derives from
   * `defaultAttached || visibility === 'shared'`; before TASK-110 the summary
   * dropped this field, so a default-on private connector wrongly showed no
   * badge). Storage-agnostic boolean — never a backing-mechanism field.
   */
  defaultAttached: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Hook I/O — the inter-plugin API. Every field is storage- and mechanism-
// agnostic. The untrusted backing-mechanism vocabulary appears ONLY inside the
// `capabilities` spec object, never as a first-class field here.
// ---------------------------------------------------------------------------

export interface ListInput {
  userId: string;
}
export interface ListOutput {
  connectors: ConnectorSummary[];
}

export interface GetInput {
  userId: string;
  connectorId: string;
}
export interface GetOutput {
  connector: Connector;
}

export interface UpsertInput {
  userId: string;
  connectorId: string;
  name: string;
  description?: string;
  usageNote?: string;
  keyMode: KeyMode;
  visibility: Visibility;
  capabilities: Capabilities;
  /**
   * TASK-97 — optional workspace-default flag. Omitted ⟹ false (a fresh
   * connector is not a default until explicitly flagged). This is the admin
   * write that flips a connector default-on; the management UI / admin route
   * (a later card) sets it. Re-upserting without it does NOT silently clear an
   * existing flag — the store preserves the prior value when the field is absent.
   */
  defaultAttached?: boolean;
}
export interface UpsertOutput {
  connector: Connector;
  /** True iff this call created a new connector (vs. updating an existing one). */
  created: boolean;
}

export interface DeleteInput {
  userId: string;
  connectorId: string;
  /**
   * Whether the caller is authorized to purge GLOBAL-scope (shared/company)
   * credentials as part of the delete. Omitted/false ⟹ ONLY the caller's own
   * per-user (`scope:'user'`, `ownerId:userId`) credential refs are purged;
   * global-scope refs are LEFT INTACT. A global (company) key is shared
   * infrastructure — owner-independent, keyed by the connector id — so only an
   * admin may tombstone it on delete. Routes pass `actor.isAdmin`. This is the
   * security boundary that stops a non-admin who somehow owns a workspace
   * connector (e.g. via the authored-connector approve path, which the HTTP
   * keyMode gate doesn't cover) from wiping a company key. Storage-agnostic:
   * a granted capability flag, no backend vocabulary.
   */
  purgeGlobal?: boolean;
}
export interface DeleteOutput {
  deleted: boolean;
}

/**
 * Payload of the `connectors:deleted` SUBSCRIBER event, fired by
 * `connectors:delete` after a connector is actually removed (`deleted: true`
 * and the row was live). Lets other plugins reclaim per-tool state keyed on the
 * connector's tool namespaces (e.g. `@ax/tool-policy` verdict rows) without this
 * plugin knowing they exist.
 *
 * `toolNamespaces` is the same shape `connectors:resolve` returns, derived from
 * the row OWNER before the delete, so a subscriber can match the exact
 * namespaces it was handed earlier. No owner/user field rides the payload (the
 * namespace already encodes the owner) and nothing here is storage-specific.
 * Empty for a connector with no MCP servers. Best-effort: subscriber failures
 * never fail the delete.
 */
export interface ConnectorDeletedEvent {
  connectorId: string;
  toolNamespaces: ToolNamespaceEntry[];
}

/**
 * Payload of the `connectors:tool-namespaces-changed` SUBSCRIBER event
 * (TASK-752), fired by `connectors:upsert` when an edit changed which
 * namespaces a LIVE connector's MCP servers live under — a server was renamed
 * (its namespace is a hash of its name) or removed — or kept a server's name
 * but pointed it at a different endpoint (TASK-755). Lets plugins that key
 * per-tool state on a namespace (`@ax/tool-policy` verdict rows) move it to
 * the new namespace or drop it, instead of leaving it orphaned or handing it
 * to a different service.
 *
 * `renamed` pairs the old entry with the new one for a server that is the same
 * server under a new name; `removed` lists entries whose per-tool state must be
 * dropped: the server is gone, OR it kept its name (so the namespace is still
 * live) but now reaches a different endpoint. A subscriber must treat `removed`
 * as "forget what you stored here", not as "this namespace no longer exists". Same
 * entry shape as `connectors:deleted`; no owner field (the namespace encodes
 * it). Not fired for a create, or when nothing moved. Best-effort: subscriber
 * failures never fail the upsert.
 */
export interface ConnectorToolNamespacesChangedEvent {
  connectorId: string;
  renamed: Array<{ from: ToolNamespaceEntry; to: ToolNamespaceEntry }>;
  removed: ToolNamespaceEntry[];
}

/**
 * Resolve a connector id to its mechanism-agnostic spec descriptor — the
 * future routing entry point (a credential-proxy / sandbox-spawn caller will
 * resolve a connector to its declared credentials + allowedHosts + backing
 * mechanism here, instead of reading the skill's capability block). Distinct
 * from `connectors:get` so the routing surface can evolve (e.g. union shared
 * + catalog connectors) without widening the management read.
 */
export interface ResolveInput {
  userId: string;
  connectorId: string;
}
export interface ResolveOutput {
  id: string;
  keyMode: KeyMode;
  /**
   * The connector's "how to use me" blurb. Storage-agnostic, model-facing text
   * (not management chrome like name/description) — the orchestrator folds it
   * into the connector's synthetic SKILL.md body so the agent learns how to use
   * the connector. Empty string when the owner left it blank, in which case the
   * orchestrator falls back to a generic blurb. MUST be carried here: it's the
   * ONLY resolve path for owner-owned / per-agent-attached connectors (only
   * `connectors:list-defaults` returns it otherwise), so dropping it silently
   * stripped every non-default connector's instructions.
   */
  usageNote: string;
  /** The mechanism-agnostic fill the resolver routes on. */
  capabilities: Capabilities;
  /**
   * The derived credential plan (TASK-96 — reach-by-attachment). One entry per
   * declared credential slot, mapping the connector's `keyMode` to the credential
   * SCOPE the key attaches to (`personal` → `user`, `workspace` → `global`) and
   * the deterministic `account:<service>` vault ref. The connect flow / future
   * credential-proxy router uses this to know whose key to prompt for / spend.
   * Empty when the connector declares no credential slots. Storage-agnostic —
   * `scope` is the neutral credential-scope contract, not backend vocabulary.
   */
  credentialPlan: CredentialPlanEntry[];
  /**
   * Whether the connect flow must surface the shared-key consent moment before
   * the key becomes spendable (design "Consent caveat", invariant #5). True iff
   * `keyMode === 'workspace'` (one key, every allowed agent spends it) or the
   * connector's `visibility === 'shared'` (bound to a shared/team agent).
   */
  requiresSharedKeyConsent: boolean;
  /**
   * The canonical tool namespace of each MCP server this connector declares —
   * one entry per `capabilities.mcpServers[]` entry, in that order; empty when
   * the connector declares none. The orchestrator materializes each server into
   * the sandbox under its `toolNamespace` (not its spec `name`), so the tool the
   * model calls (`mcp__<toolNamespace>__<tool>`) maps to the permission toolKey
   * `mcp.<toolNamespace>.<tool>` and can never collide with another connector's
   * server of the same name. Derived from the connector ROW owner + id + server
   * name (see `tool-namespace.ts`) — NOT the requesting user and NOT the agent,
   * so a shared connector resolves to the same namespace for everyone.
   * Storage-agnostic: an opaque alias, no backend vocabulary.
   */
  toolNamespaces: ToolNamespaceEntry[];
}

/**
 * TASK-744 — `connectors:tool-labels`: which connector each tool namespace
 * belongs to, so a person reads "Linear · Create issue" instead of the opaque
 * `mcp.c0123456789.create_issue` toolKey (TASK-734).
 *
 * Scope: exactly the connectors `userId` can resolve (`connectors:list`'s set —
 * owned, or an unambiguous shared one), one entry per declared MCP server. A
 * namespace that is not in the answer is NOT the caller's to name: render the
 * tool name alone. That is also the fallback for a connector deleted since the
 * call ran.
 *
 * `name` is the connector's management display name — written by its author
 * (a person, or a model for an approved authored connector), so callers fence
 * it before it reaches a screen. `toolNamespace` is the same opaque alias
 * `connectors:resolve` returns; it is a lookup key, never something to show.
 *
 * TASK-753 — `tools`, when present, is the MCP server's own display title for
 * each of that namespace's tools that has one, as `connectors:describe-tools`
 * last cached it for `userId` (read through @ax/mcp-client's cache-only
 * `connectors:inventory-tool-titles` — this hook never reaches a server).
 * Callers prefer `title` over a humanized `name`. Absent when no title is
 * cached (or no inventory plugin is loaded). `title` is UNTRUSTED third-party
 * text: fence and clamp it before it reaches a screen, exactly like `name`.
 */
export interface ToolLabelsInput {
  userId: string;
}
export interface ToolLabelsOutput {
  connectors: Array<{
    toolNamespace: string;
    connectorId: string;
    name: string;
    tools?: Array<{ name: string; title: string }>;
  }>;
}

/**
 * List the workspace-DEFAULT connectors — those flagged `defaultAttached` (the
 * admin-curated set that flows into every agent's effective connector set).
 * Mirrors `skills:list-defaults`. Returns FULL connectors (capabilities
 * included) because the orchestrator union materializes their declared reach
 * into the sandbox; a metadata-only summary wouldn't carry the
 * allowedHosts/credentials/mcpServers/packages the union needs.
 *
 * `userId` is OPTIONAL so the routing surface can evolve to a per-user overlay
 * (mirroring `skills:list-defaults`'s `ownerUserId`); in this slice defaults are
 * owner-scoped to the supplied user (each owner's own default-flagged
 * connectors), with the system-wide overlay deferred to the catalog/admin work.
 */
export interface ListDefaultsInput {
  userId?: string;
}
export interface ListDefaultsOutput {
  /**
   * Each default connector carries its `toolNamespaces` (same field, same
   * derivation as `connectors:resolve` — row owner + id + server name), so the
   * orchestrator union can namespace default connectors' MCP servers without a
   * second round trip.
   */
  connectors: Array<Connector & { toolNamespaces: ToolNamespaceEntry[] }>;
}

/**
 * TASK-739 — `connectors:list-effective`: the ONE implementation of an agent's
 * effective connector set. Host-internal (no IPC surface). The orchestrator
 * folds `capabilities` + `toolNamespaces` into the sandbox; the agent connector
 * list UI shows `summary` + `source`.
 *
 * Union, in order, deduped by id (first wins); an id in `exclusions` is
 * skipped in the IMPLICIT sources (`default`, `legacy-owned`) — an explicit
 * attachment always wins over a stale exclusion:
 *   1. `default`      — the user's default-attached connectors (id asc).
 *   2. `attached`     — each `attachmentIds` entry the user can resolve; a
 *                       malformed / unknown id is skipped (grants nothing).
 *   3. `legacy-owned` — the user's own connectors that predate explicit
 *                       attachment (`canEdit !== false && requiresAttachment !== true`).
 *
 * `attachmentIds` / `exclusions` are the agent row's per-agent lists; the caller
 * passes them (this plugin never reads agent state — I2/I4).
 */
export interface ListEffectiveInput {
  userId: string;
  attachmentIds?: string[];
  exclusions?: string[];
}

export type EffectiveConnectorSource = 'default' | 'attached' | 'legacy-owned';

export interface EffectiveConnectorEntry {
  /** The same metadata-only shape `connectors:list` returns (no capabilities). */
  summary: ConnectorSummary;
  /** Which union source contributed the connector. */
  source: EffectiveConnectorSource;
  /** The mechanism-agnostic fill the orchestrator folds into the session. */
  capabilities: Capabilities;
  /** Same derivation as `connectors:resolve` (row owner + id + server name). */
  toolNamespaces: ToolNamespaceEntry[];
}

export interface ListEffectiveOutput {
  connectors: EffectiveConnectorEntry[];
}

// ---------------------------------------------------------------------------
// Authored-connector drafts (TASK-94 — install_authored_connector + the
// approval gate). The hook fields are FLAT (hosts / slots / packages /
// mcpServers) so the model-authored caller declares its surface without
// nesting a Capabilities object; the handler assembles + validates the
// canonical Capabilities from them. Backing-mechanism vocabulary stays inside
// `mcpServers` (the spec object), never as a first-class field. `status` is
// the gate verdict; a draft is `pending` (zero reach) until a human approves.
// ---------------------------------------------------------------------------

/** A single declared credential slot — public metadata, never a secret. No
 *  share-by-service `account` tag: the key is keyed by the connector id. */
export interface AuthoredConnectorSlot {
  slot: string;
  kind: 'api-key';
  description?: string;
}

/**
 * `install_authored_connector` — an agent submits a connector draft for
 * approval. (owner, agent) come from the trusted host context (the caller
 * passes them; a runner can never author into a foreign namespace because the
 * IPC server stamps them from the bound session — see the IPC seam in TASK-95).
 */
export interface InstallAuthoredInput {
  ownerUserId: string;
  agentId: string;
  connectorId: string;
  name: string;
  /** Direct-API + CLI network reach. */
  hosts: string[];
  /** Declared credential slots (names only — never values). */
  slots: AuthoredConnectorSlot[];
  /** CLI/binary backing (public registries). Defaults to empty. */
  packages?: { npm?: string[]; pypi?: string[] };
  /** MCP backing (http/stdio). Defaults to empty. */
  mcpServers?: McpServerSpec[];
  /** Light "how to use me" blurb. Defaults to ''. */
  usageNote?: string;
  keyMode: KeyMode;
}
export interface InstallAuthoredOutput {
  connectorId: string;
  /**
   * `pending` — a freshly installed draft grants zero reach until a human
   * approves it at the capability wall (the common case).
   *
   * `active` — the install was a NO-OP because an equivalent connector is
   * ALREADY approved + active in the owner's live registry (TASK-114 re-propose
   * dedup). No pending draft was (re)created and no approval card re-fires; the
   * model learns the connector already works rather than re-proposing it every
   * turn. NOTE: this never grants new reach — it only reports an existing,
   * human-approved connector.
   */
  status: 'pending' | 'active';
}

/** One authored connector draft, as surfaced for the approval card + the grant
 *  re-resolution. `proposal` is the declared, UNAPPROVED capability surface. */
export interface AuthoredConnectorDraftDescriptor {
  connectorId: string;
  name: string;
  usageNote: string;
  keyMode: KeyMode;
  status: 'pending' | 'active';
  proposal: Capabilities;
}

export interface ListAuthoredInput {
  ownerUserId: string;
  agentId: string;
}
export interface ListAuthoredOutput {
  drafts: AuthoredConnectorDraftDescriptor[];
}

/** One pending draft surfaced ACROSS the user's agents (Settings fallback);
 *  carries `agentId` so the approve action knows which (user, agent) authored
 *  it. */
export interface PendingAuthoredConnectorDescriptor
  extends AuthoredConnectorDraftDescriptor {
  agentId: string;
}

export interface ListAuthoredPendingInput {
  userId: string;
}
export interface ListAuthoredPendingOutput {
  drafts: PendingAuthoredConnectorDescriptor[];
}

export interface ActivateAuthoredInput {
  ownerUserId: string;
  agentId: string;
  connectorId: string;
}
export interface ActivateAuthoredOutput {
  /** True iff THIS call flipped a `pending` draft to `active`. */
  activated: boolean;
}

export interface ClearAuthoredInput {
  ownerUserId: string;
  agentId: string;
  connectorId: string;
}
export interface ClearAuthoredOutput {
  /** True iff a draft row was removed. */
  cleared: boolean;
}

/**
 * `credentials:authorize-global:account` — the read-authorization seam
 * @ax/credentials consults before it lets an `account:` ref fall through to the
 * GLOBAL (company-wide) scope (TASK-697). Structural mirror of the contract
 * @ax/credentials declares (I2 — no cross-plugin import). Storage- and
 * mechanism-agnostic: a user id and an opaque ref in, a boolean out.
 */
export interface AuthorizeGlobalInput {
  userId: string;
  ref: string;
}
export interface AuthorizeGlobalOutput {
  allowed: boolean;
}

/**
 * `credentials:authorize-agent:account` — the AGENT-scope twin (TASK-711):
 * may `userId` read the credential stored on agent `agentId` for this
 * `account:` ref? Consulted by @ax/credentials before the agent step, and by
 * @ax/mcp-oauth to pick where a team-agent sign-in is stored. Ids and an
 * opaque ref in, a boolean out.
 */
export interface AuthorizeAgentInput {
  userId: string;
  agentId: string;
  ref: string;
}
export interface AuthorizeAgentOutput {
  allowed: boolean;
}

// ---------------------------------------------------------------------------
// Return schemas — registered with the hooks so the bus validates the response
// shape (a mismatch becomes PluginError('invalid-return')).
// ---------------------------------------------------------------------------

const KeyModeSchema = z.union([z.literal('personal'), z.literal('workspace')]);
const VisibilitySchema = z.union([z.literal('private'), z.literal('shared')]);

const ConnectorSummarySchema = z.object({
  canEdit: z.boolean().optional(),
  requiresAttachment: z.boolean().optional(),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  usageNote: z.string(),
  keyMode: KeyModeSchema,
  visibility: VisibilitySchema,
  defaultAttached: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ConnectorSchema = z.object({
  canEdit: z.boolean().optional(),
  requiresAttachment: z.boolean().optional(),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  usageNote: z.string(),
  keyMode: KeyModeSchema,
  visibility: VisibilitySchema,
  capabilities: CapabilitiesSchema,
  defaultAttached: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Cast to `ZodType<…Output>` (not direct assignment): the embedded
// CapabilitiesSchema is itself a cast (exactOptionalPropertyTypes vs zod's
// `.optional()` widening), so the inferred output type won't prove directly
// assignable to the interface. `return-schemas.test.ts` is the drift guard.
export const ListOutputSchema = z.object({
  connectors: z.array(ConnectorSummarySchema),
}) as unknown as ZodType<ListOutput>;

export const GetOutputSchema = z.object({
  connector: ConnectorSchema,
}) as unknown as ZodType<GetOutput>;

export const UpsertOutputSchema = z.object({
  connector: ConnectorSchema,
  created: z.boolean(),
}) as unknown as ZodType<UpsertOutput>;

export const DeleteOutputSchema = z.object({
  deleted: z.boolean(),
}) as unknown as ZodType<DeleteOutput>;

// The derived credential plan + consent gate (TASK-96). `scope` is the neutral
// credential-scope contract (NOT backend vocab); only the two scopes the keyMode
// derivation produces are accepted. `ref` is the opaque `account:<service>` vault
// ref. These are storage-agnostic first-class fields (like keyMode/visibility) —
// the leak-guard test pins that they introduce no mechanism vocabulary.
const CredentialPlanEntrySchema = z.object({
  slot: z.string(),
  scope: z.union([z.literal('user'), z.literal('global')]),
  ref: z.string(),
  // TASK-124 — structured destination bits so the connect-flow UI rebuilds the
  // `{kind:'account', service, slot?}` destination without string-parsing the
  // `:`-bearing per-slot ref. `service` is always present; `slotTag` is present
  // only for a multi-slot connector's per-slot ref. Storage-agnostic.
  service: z.string(),
  slotTag: z.string().optional(),
});

// TASK-734 — one opaque namespace per declared MCP server. `server` is the spec's
// own name (an input to the derivation); `toolNamespace` is the derived alias the
// tools are exposed under. Both are neutral strings, never backend vocabulary.
const ToolNamespaceEntrySchema = z.object({
  server: z.string(),
  toolNamespace: z.string(),
});

export const ResolveOutputSchema = z.object({
  id: z.string(),
  keyMode: KeyModeSchema,
  usageNote: z.string(),
  capabilities: CapabilitiesSchema,
  credentialPlan: z.array(CredentialPlanEntrySchema),
  requiresSharedKeyConsent: z.boolean(),
  toolNamespaces: z.array(ToolNamespaceEntrySchema),
}) as unknown as ZodType<ResolveOutput>;

export const ToolLabelsOutputSchema = z.object({
  connectors: z.array(
    z.object({
      toolNamespace: z.string(),
      connectorId: z.string(),
      name: z.string(),
      tools: z.array(z.object({ name: z.string(), title: z.string() })).optional(),
    }),
  ),
}) as unknown as ZodType<ToolLabelsOutput>;

export const ListDefaultsOutputSchema = z.object({
  connectors: z.array(
    ConnectorSchema.extend({ toolNamespaces: z.array(ToolNamespaceEntrySchema) }),
  ),
}) as unknown as ZodType<ListDefaultsOutput>;

export const ListEffectiveOutputSchema = z.object({
  connectors: z.array(
    z.object({
      summary: ConnectorSummarySchema,
      source: z.union([
        z.literal('default'),
        z.literal('attached'),
        z.literal('legacy-owned'),
      ]),
      capabilities: CapabilitiesSchema,
      toolNamespaces: z.array(ToolNamespaceEntrySchema),
    }),
  ),
}) as unknown as ZodType<ListEffectiveOutput>;

const AuthoredConnectorDraftSchema = z.object({
  connectorId: z.string(),
  name: z.string(),
  usageNote: z.string(),
  keyMode: KeyModeSchema,
  status: z.union([z.literal('pending'), z.literal('active')]),
  proposal: CapabilitiesSchema,
});

export const InstallAuthoredOutputSchema = z.object({
  connectorId: z.string(),
  // `active` is returned only by the TASK-114 re-propose dedup no-op (an
  // equivalent connector is already approved/active in the live registry).
  status: z.union([z.literal('pending'), z.literal('active')]),
}) as unknown as ZodType<InstallAuthoredOutput>;

export const ListAuthoredOutputSchema = z.object({
  drafts: z.array(AuthoredConnectorDraftSchema),
}) as unknown as ZodType<ListAuthoredOutput>;

const PendingAuthoredConnectorSchema = AuthoredConnectorDraftSchema.extend({
  agentId: z.string(),
});

export const ListAuthoredPendingOutputSchema = z.object({
  drafts: z.array(PendingAuthoredConnectorSchema),
}) as unknown as ZodType<ListAuthoredPendingOutput>;

export const ActivateAuthoredOutputSchema = z.object({
  activated: z.boolean(),
}) as unknown as ZodType<ActivateAuthoredOutput>;

export const ClearAuthoredOutputSchema = z.object({
  cleared: z.boolean(),
}) as unknown as ZodType<ClearAuthoredOutput>;

export const AuthorizeGlobalOutputSchema = z.object({
  allowed: z.boolean(),
}) as unknown as ZodType<AuthorizeGlobalOutput>;

export const AuthorizeAgentOutputSchema = z.object({
  allowed: z.boolean(),
}) as unknown as ZodType<AuthorizeAgentOutput>;
