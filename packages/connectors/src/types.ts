import { z, type ZodType } from 'zod';
import type {
  Capabilities,
  CapabilitySlot,
  McpServerSpec,
  PackagesSpec,
} from '@ax/skills-parser';
// Type-only import of the derived plan entry — no runtime cycle (types are
// erased; credential-plan.ts imports the domain types from here).
import type { CredentialPlanEntry } from './credential-plan.js';

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
export type { Capabilities, CapabilitySlot, McpServerSpec, PackagesSpec };

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
const CapabilitySlotSchema = z.object({
  slot: z.string(),
  kind: z.literal('api-key'),
  description: z.string().optional(),
  account: z.string().optional(),
});

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

export const CapabilitiesSchema = z.object({
  allowedHosts: z.array(z.string()),
  credentials: z.array(CapabilitySlotSchema),
  mcpServers: z.array(McpServerSpecSchema),
  packages: PackagesSpecSchema,
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
  id: string;
  name: string;
  description: string;
  usageNote: string;
  keyMode: KeyMode;
  visibility: Visibility;
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
}
export interface DeleteOutput {
  deleted: boolean;
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
  connectors: Connector[];
}

// ---------------------------------------------------------------------------
// Return schemas — registered with the hooks so the bus validates the response
// shape (a mismatch becomes PluginError('invalid-return')).
// ---------------------------------------------------------------------------

const KeyModeSchema = z.union([z.literal('personal'), z.literal('workspace')]);
const VisibilitySchema = z.union([z.literal('private'), z.literal('shared')]);

const ConnectorSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  usageNote: z.string(),
  keyMode: KeyModeSchema,
  visibility: VisibilitySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ConnectorSchema = z.object({
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
});

export const ResolveOutputSchema = z.object({
  id: z.string(),
  keyMode: KeyModeSchema,
  capabilities: CapabilitiesSchema,
  credentialPlan: z.array(CredentialPlanEntrySchema),
  requiresSharedKeyConsent: z.boolean(),
}) as unknown as ZodType<ResolveOutput>;

export const ListDefaultsOutputSchema = z.object({
  connectors: z.array(ConnectorSchema),
}) as unknown as ZodType<ListDefaultsOutput>;
