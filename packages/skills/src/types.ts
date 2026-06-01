/**
 * @ax/skills public hook payload types.
 *
 * Inter-plugin API. A future @ax/skills-fs (file-backed impl) would
 * register the same `skills:*` service hooks with these exact shapes —
 * no field here mentions postgres, rows, or any storage detail.
 */

import { z, type ZodType } from 'zod';
import type { SkillCapabilities } from '@ax/skills-parser';
import type { SkillTier } from './catalog-tier.js';
import type { ApprovedCapEntry } from './approved-caps-store.js';
export type { CapabilitySlot, McpServerSpec, SkillCapabilities } from '@ax/skills-parser';
export type { SkillTier } from './catalog-tier.js';

export interface SkillSummary {
  id: string;
  description: string;
  version: number;
  /**
   * Soft-dependency reference list: the connector ids this skill declares it
   * uses (connectors-first-class design). Always present; defaults to `[]` for a
   * skill that declares none. A DECLARED REFERENCE only — the connector
   * definitions (allowedHosts / credentials / mcpServers / packages) live in
   * @ax/connectors. A skill no longer carries a capability block at all
   * (TASK-100 closed the half-wired window): ALL of a skill's reach flows from
   * the connectors it references, resolved through `connectors:resolve` (the
   * human-approved/curated table — a pending connector grants ZERO reach).
   * Derived from the manifest YAML (one source of truth) on read — never a
   * stored column.
   */
  connectors: string[];
  defaultAttached: boolean;
  sourceUrl?: string;
  updatedAt: string;
  /** Storage scope for this skill. 'global' = admin-managed; 'user' = user-private copy. */
  scope: 'global' | 'user';
  /** Present iff scope === 'user'. The user who owns this private skill copy. */
  ownerUserId?: string;
}

/** An extra (non-SKILL.md) bundle file. SKILL.md stays in manifestYaml/bodyMd. */
export interface BundleFile {
  path: string;
  contents: string;
}

export interface SkillDetail extends SkillSummary {
  bodyMd: string;
  manifestYaml: string;
  /** Extra (non-SKILL.md) bundle files. Empty for single-file skills. */
  files: BundleFile[];
}

export interface ResolvedSkill {
  id: string;
  /**
   * Soft-dependency connector-id reference list (see {@link SkillSummary}).
   * Always present; defaults to `[]`. Derived from the manifest on read. A skill
   * carries no capability block (TASK-100); its reach flows from these
   * connectors, resolved by the orchestrator (the skill→connector bridge).
   */
  connectors: string[];
  bodyMd: string;
  manifestYaml: string;
  /** Extra (non-SKILL.md) bundle files. Empty for single-file skills. */
  files: BundleFile[];
}

export interface SkillsListInput {
  /** 'all' (default) = global + user rows unioned; 'global' = admin rows only; 'user' = user rows only. */
  scope?: 'all' | 'global' | 'user';
  /** Required when scope === 'user' or scope === 'all' to include user rows. */
  ownerUserId?: string;
}
export interface SkillsListOutput {
  skills: SkillSummary[];
}

export interface SkillsGetInput {
  skillId: string;
  /** If omitted or 'all': user row wins over global when ownerUserId is provided. */
  scope?: 'all' | 'global' | 'user';
  ownerUserId?: string;
}
export type SkillsGetOutput = SkillDetail;

export interface SkillsUpsertInput {
  manifestYaml: string;
  bodyMd: string;
  /**
   * Extra (non-SKILL.md) bundle files to persist alongside the manifest.
   * Optional — absent/empty means a single-file (SKILL.md-only) skill, the
   * byte-identical behavior of pre-bundle skills. Validated host-side
   * (validateBundleFiles) before the store writes them.
   */
  files?: BundleFile[];
  defaultAttached?: boolean;
  /** 'global' (default) = admin-managed table; 'user' = user-private table. */
  scope?: 'global' | 'user';
  /** Required when scope === 'user'. */
  ownerUserId?: string;
}
export interface SkillsUpsertOutput {
  skillId: string;
  created: boolean;
}

export interface SkillsDeleteInput {
  skillId: string;
  /** 'global' (default) = admin-managed table; 'user' = user-private table. */
  scope?: 'global' | 'user';
  /** Required when scope === 'user'. */
  ownerUserId?: string;
}
export type SkillsDeleteOutput = Record<string, never>;

export interface SkillsResolveInput {
  skillIds: string[];
  /** When provided, user-scoped skills are resolved and override same-id globals. */
  ownerUserId?: string;
}
export interface SkillsResolveOutput {
  skills: ResolvedSkill[];
}

export interface SkillsListDefaultsInput {
  /** When provided, user-scoped default skills are unioned with globals (user wins on collision). */
  ownerUserId?: string;
}
export interface SkillsListDefaultsOutput {
  skills: ResolvedSkill[];
}

// Phase C — version-aware refresh hook surface. Storage-agnostic and
// alternate-impl-friendly: a future "skill registry index" plugin can
// implement this same hook against an internal catalog instead of the
// fetch-based logic in @ax/skills/check-updates.ts. See the locked
// boundary review in docs/plans/2026-05-20-skills-versioning-design-note.md
// (C-design.3) for details.
export interface SkillsCheckForUpdatesInput {
  skillId: string;
}
export interface SkillsCheckForUpdatesOutput {
  available: boolean;        // false if sourceUrl unset OR latestVersion <= currentVersion
  currentVersion: number;
  latestVersion?: number;    // when sourceUrl is set, the version we successfully fetched
  latestSkillMd?: string;    // present iff available === true (the freshly-fetched body)
}

// ---------------------------------------------------------------------------
// Per-user skill attachment (TASK-33). Self-serve layer above the admin-managed
// agent-global attachments owned by @ax/agents. A future @ax/skills-fs impl
// would register these same hooks with these exact shapes — no field mentions
// postgres, rows, or any storage detail. `agentId`/`skillId`/`userId` are
// opaque ids; `credentialBindings` maps a declared slot to an opaque credential
// ref (NEVER a secret — same posture as the agent-global attachment shape).
// ---------------------------------------------------------------------------
export interface UserSkillAttachment {
  skillId: string;
  credentialBindings: Record<string, string>;
}

export interface SkillsAttachForUserInput {
  userId: string;
  agentId: string;
  skillId: string;
  credentialBindings: Record<string, string>;
}
export interface SkillsAttachForUserOutput {
  created: boolean;
}

export interface SkillsListUserAttachmentsInput {
  userId: string;
  agentId: string;
}
export interface SkillsListUserAttachmentsOutput {
  attachments: UserSkillAttachment[];
}

// Detach (TASK-42, Settings "Connections" mirror property — design P6). The
// out-of-band twin of skills:attach-for-user: removes one per-(user, agent)
// attachment so a user can revoke a skill they self-attached. Host-internal,
// NOT an IPC action — the untrusted runner must never detach a user's skills;
// the sole caller is the authenticated, CSRF-gated channel-web detach route.
// Same storage-agnostic posture as attach: opaque ids in, a plain boolean out.
export interface SkillsDetachForUserInput {
  userId: string;
  agentId: string;
  skillId: string;
}
export interface SkillsDetachForUserOutput {
  removed: boolean;
}

// ---------------------------------------------------------------------------
// Catalog search (TASK-34, JIT surfacing spine — design §11.1). Read-only:
// match a free-text intent against the GLOBAL catalog and return candidate
// summaries the model can act on. Storage-agnostic — `tier` is derived from
// declared capabilities (one source of truth, no row), `hosts`/`slots` are
// already public in the manifest. Alternate impl: keyword today, vector
// tomorrow; the payload is impl-agnostic.
// ---------------------------------------------------------------------------
export interface SkillsSearchCatalogInput {
  /** Free-text intent/keywords from the model. UNTRUSTED — never reaches SQL. */
  intent: string;
  /** Max candidates to return. Clamped to [1, 50]; defaults to 10. */
  limit?: number;
}
export interface CatalogCandidate {
  id: string;
  description: string;
  tier: SkillTier;
  /** Hostnames the skill is allowed to reach (already public in the manifest). */
  hosts: string[];
  /** Credential slot names the skill declares. */
  slots: string[];
}
export interface SkillsSearchCatalogOutput {
  skills: CatalogCandidate[];
}

// ---------------------------------------------------------------------------
// Runtime `returns` contracts for the `skills:*` service hooks (ARCH-13,
// the non-IPC / non-boundary long tail spun out of ARCH-6 #150).
//
// Same recipe as ARCH-6's credentials precedent: a per-registration in-process
// shape assertion (NOT an inter-plugin wire — that's @ax/ipc-protocol),
// co-located with the I/O interfaces above. The HookBus validates the handler's
// return against the schema and strips undeclared keys (hook-bus.ts:141-147),
// so each schema is a faithful shape of the public interface.
//
// Storage-agnostic by construction — every field name mirrors the interface
// (no postgres/row vocab). `version`/`currentVersion`/`latestVersion` are plain
// numbers; `updatedAt` is an ISO-8601 string (the interfaces declare `string`,
// NOT `Date`, so `z.string()` is correct here — unlike agents/teams which
// return real `Date` instances). Cast to `ZodType<…>` because zod's
// `.optional()` infers `| undefined` shapes that `exactOptionalPropertyTypes`
// won't prove directly assignable to the interface; `return-schemas.test.ts` is
// the drift guard.
// ---------------------------------------------------------------------------
// TASK-100 — the SkillCapabilities / CapabilitySlot / McpServerSpec zod schemas
// were removed: a skill's hook payloads (SkillSummary / ResolvedSkill / the
// catalog candidate) no longer carry a capability block. The Capabilities shape
// is still validated where it belongs — on the CONNECTOR, by @ax/connectors'
// own CapabilitiesSchema.

const SkillSummarySchema = z.object({
  id: z.string(),
  description: z.string(),
  version: z.number(),
  connectors: z.array(z.string()),
  defaultAttached: z.boolean(),
  sourceUrl: z.string().optional(),
  updatedAt: z.string(),
  scope: z.union([z.literal('global'), z.literal('user')]),
  ownerUserId: z.string().optional(),
});

// Bundle extra-file shape — present on SkillDetail and ResolvedSkill. The
// HookBus strips undeclared keys against the `returns` schema, so `files`
// MUST appear here or skills:get / skills:resolve would silently drop the
// bundle's extra files. `return-schemas.test.ts` is the drift guard.
const BundleFileSchema = z.object({
  path: z.string(),
  contents: z.string(),
});

const SkillDetailSchema = SkillSummarySchema.extend({
  bodyMd: z.string(),
  manifestYaml: z.string(),
  files: z.array(BundleFileSchema),
});

const ResolvedSkillSchema = z.object({
  id: z.string(),
  connectors: z.array(z.string()),
  bodyMd: z.string(),
  manifestYaml: z.string(),
  files: z.array(BundleFileSchema),
});

export const SkillsListOutputSchema = z.object({
  skills: z.array(SkillSummarySchema),
}) as unknown as ZodType<SkillsListOutput>;

export const SkillsGetOutputSchema = SkillDetailSchema as unknown as ZodType<SkillsGetOutput>;

export const SkillsUpsertOutputSchema = z.object({
  skillId: z.string(),
  created: z.boolean(),
}) as unknown as ZodType<SkillsUpsertOutput>;

export const SkillsDeleteOutputSchema = z
  .object({})
  .strict() as unknown as ZodType<SkillsDeleteOutput>;

export const SkillsResolveOutputSchema = z.object({
  skills: z.array(ResolvedSkillSchema),
}) as unknown as ZodType<SkillsResolveOutput>;

export const SkillsListDefaultsOutputSchema = z.object({
  skills: z.array(ResolvedSkillSchema),
}) as unknown as ZodType<SkillsListDefaultsOutput>;

export const SkillsCheckForUpdatesOutputSchema = z.object({
  available: z.boolean(),
  currentVersion: z.number(),
  latestVersion: z.number().optional(),
  latestSkillMd: z.string().optional(),
}) as unknown as ZodType<SkillsCheckForUpdatesOutput>;

export const SkillsAttachForUserOutputSchema = z.object({
  created: z.boolean(),
}) as unknown as ZodType<SkillsAttachForUserOutput>;

export const SkillsListUserAttachmentsOutputSchema = z.object({
  attachments: z.array(
    z.object({
      skillId: z.string(),
      credentialBindings: z.record(z.string()),
    }),
  ),
}) as unknown as ZodType<SkillsListUserAttachmentsOutput>;

export const SkillsDetachForUserOutputSchema = z.object({
  removed: z.boolean(),
}) as unknown as ZodType<SkillsDetachForUserOutput>;

const CatalogCandidateSchema = z.object({
  id: z.string(),
  description: z.string(),
  tier: z.union([z.literal('inert'), z.literal('bounded'), z.literal('registry')]),
  hosts: z.array(z.string()),
  slots: z.array(z.string()),
});

export const SkillsSearchCatalogOutputSchema = z.object({
  skills: z.array(CatalogCandidateSchema),
}) as unknown as ZodType<SkillsSearchCatalogOutput>;

// ---------------------------------------------------------------------------
// Admit-to-catalog queue (TASK-41, JIT §6D / §11.6). The self-healing
// catalog's admit queue: BOTH cold-start "a user needed X" requests and
// share-to-catalog submissions land here; an admin admits a share (promote +
// retire the author's working copy) or rejects. Storage-agnostic — a share's
// bundle crosses the boundary as files[] (NEVER a tree sha); the snapshot's
// content-addressed pointer is an internal storage detail. Alternate impl: a
// generic approval queue.
// ---------------------------------------------------------------------------
export type CatalogSubmitInput =
  | {
      kind: 'share';
      /** The catalog id to propose; must be the requester's own user-scoped skill. */
      skillId: string;
      /** The authenticated user sharing their own skill (host-supplied). */
      requestedByUserId: string;
      description?: string;
    }
  | {
      kind: 'cold-start';
      /** A proposed slug for the missing capability (dedup key). */
      skillId: string;
      requestedByUserId: string;
      /** What the user wanted — free text the admin triages. */
      description: string;
    };
export interface CatalogSubmitOutput {
  requestId: string;
  /** false when a pending request for this skillId already existed (deduped). */
  created: boolean;
  status: 'pending' | 'admitted' | 'rejected';
}

/** One admit-queue request as seen by the admin review surface. */
export interface CatalogRequest {
  requestId: string;
  kind: 'share' | 'cold-start';
  skillId: string;
  requestedByUserId: string;
  sourceOwnerUserId: string | null;
  status: 'pending' | 'admitted' | 'rejected';
  description: string;
  createdAt: string;
  /** Snapshot of the submitted bundle (share only; null for cold-start). */
  manifestYaml: string | null;
  bodyMd: string | null;
  /** Extra (non-SKILL.md) files of the snapshot. [] for cold-start/single-file. */
  files: BundleFile[];
}
export interface CatalogListRequestsInput {
  /** Defaults to 'pending'. */
  status?: 'pending' | 'admitted' | 'rejected' | 'all';
}
export interface CatalogListRequestsOutput {
  requests: CatalogRequest[];
}

export interface CatalogAdmitInput {
  requestId: string;
  decision: 'admit' | 'reject';
  /** The authenticated admin deciding (host-supplied). */
  decidedByUserId: string;
}
export interface CatalogAdmitOutput {
  /** The promoted catalog id (present on a successful admit). */
  skillId?: string;
  admitted: boolean;
}

export const CatalogSubmitOutputSchema = z.object({
  requestId: z.string(),
  created: z.boolean(),
  status: z.union([z.literal('pending'), z.literal('admitted'), z.literal('rejected')]),
}) as unknown as ZodType<CatalogSubmitOutput>;

const CatalogRequestSchema = z.object({
  requestId: z.string(),
  kind: z.union([z.literal('share'), z.literal('cold-start')]),
  skillId: z.string(),
  requestedByUserId: z.string(),
  sourceOwnerUserId: z.string().nullable(),
  status: z.union([z.literal('pending'), z.literal('admitted'), z.literal('rejected')]),
  description: z.string(),
  createdAt: z.string(),
  manifestYaml: z.string().nullable(),
  bodyMd: z.string().nullable(),
  files: z.array(BundleFileSchema),
});

export const CatalogListRequestsOutputSchema = z.object({
  requests: z.array(CatalogRequestSchema),
}) as unknown as ZodType<CatalogListRequestsOutput>;

export const CatalogAdmitOutputSchema = z.object({
  skillId: z.string().optional(),
  admitted: z.boolean(),
}) as unknown as ZodType<CatalogAdmitOutput>;

// ---- Quarantine (Phase 2) -------------------------------------------------
// Per-(user, agent, skill) draft-skill safety status. Set by the validator
// commit scan; read by the host discovery projection (Phase 3) to omit drafts.
export interface SkillsQuarantineSetInput {
  ownerUserId: string;
  agentId: string;
  skillId: string;
  reason: string;
}
export type SkillsQuarantineSetOutput = Record<string, never>;

export interface SkillsQuarantineClearInput {
  ownerUserId: string;
  agentId: string;
  skillId: string;
}
export interface SkillsQuarantineClearOutput {
  cleared: boolean;
}

export interface SkillsQuarantineGetInput {
  ownerUserId: string;
  agentId: string;
  skillId: string;
}
export interface SkillsQuarantineGetOutput {
  quarantined: boolean;
  reason?: string;
}

export interface SkillsQuarantineListInput {
  ownerUserId: string;
  agentId: string;
}
export interface SkillsQuarantineListOutput {
  items: Array<{ skillId: string; reason: string; lastFlaggedAt: string }>;
}

export const SkillsQuarantineSetOutputSchema = z
  .object({})
  .strict() as unknown as ZodType<SkillsQuarantineSetOutput>;
export const SkillsQuarantineClearOutputSchema = z.object({
  cleared: z.boolean(),
}) as unknown as ZodType<SkillsQuarantineClearOutput>;
export const SkillsQuarantineGetOutputSchema = z.object({
  quarantined: z.boolean(),
  reason: z.string().optional(),
}) as unknown as ZodType<SkillsQuarantineGetOutput>;
export const SkillsQuarantineListOutputSchema = z.object({
  items: z.array(
    z.object({ skillId: z.string(), reason: z.string(), lastFlaggedAt: z.string() }),
  ),
}) as unknown as ZodType<SkillsQuarantineListOutput>;

// ---- Approved capabilities (Phase 4) --------------------------------------
// Per-(user, agent, skill) approved-capability metadata. Read by the host
// discovery projection (agents:resolve-authored-skills) to grant only the
// approved subset of a self-authored draft's frontmatter proposal. Written by
// the approval grant path (PR-B). The bundle frontmatter is the proposal source
// of truth; these rows are thin approval metadata (I4).

/** A capability a human approved, storage-agnostic. Single source of truth
 * lives in the store (same plugin) — re-exported here as part of the public
 * hook payload surface so consumers import it from @ax/skills. */
export type { ApprovedCapEntry };

// TASK-93 — the grant SUBJECT is exactly one of {skill, connector}. The same
// wall now attributes an approved capability to a connector ref as well as a
// skill ref (design §"reuse the existing approval wall"). Both fields are
// optional on the wire; the registered handler enforces exactly-one (a
// PluginError otherwise). Existing `{ skillId }` callers are unchanged.
export interface SkillsApprovedCapsListInput {
  ownerUserId: string;
  agentId: string;
  /** Skill-scoped grant subject (mutually exclusive with `connectorId`). */
  skillId?: string;
  /** Connector-scoped grant subject (mutually exclusive with `skillId`). */
  connectorId?: string;
}
export interface SkillsApprovedCapsListOutput {
  capabilities: ApprovedCapEntry[];
}

export const SkillsApprovedCapsListOutputSchema = z.object({
  capabilities: z.array(
    z.object({
      kind: z.union([
        z.literal('host'),
        z.literal('slot'),
        z.literal('npm'),
        z.literal('pypi'),
        z.literal('mcp'),
      ]),
      value: z.string(),
    }),
  ),
}) as unknown as ZodType<SkillsApprovedCapsListOutput>;

export interface SkillsApprovedCapsSetInput {
  ownerUserId: string;
  agentId: string;
  /** Skill-scoped grant subject (mutually exclusive with `connectorId`). */
  skillId?: string;
  /** Connector-scoped grant subject (mutually exclusive with `skillId`). */
  connectorId?: string;
  kind: 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';
  value: string;
  /** Optional audit/display detail (slot kind + account). The projection
   * matches on (kind, value) only; this is never read back by list(). */
  detail?: { kind?: 'api-key'; account?: string } | null;
}
export interface SkillsApprovedCapsSetOutput {
  created: boolean;
}
export interface SkillsApprovedCapsRevokeInput {
  ownerUserId: string;
  agentId: string;
  /** Skill-scoped grant subject (mutually exclusive with `connectorId`). */
  skillId?: string;
  /** Connector-scoped grant subject (mutually exclusive with `skillId`). */
  connectorId?: string;
  kind: 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';
  value: string;
}
export interface SkillsApprovedCapsRevokeOutput {
  cleared: boolean;
}

export const SkillsApprovedCapsSetOutputSchema = z.object({
  created: z.boolean(),
}) as unknown as ZodType<SkillsApprovedCapsSetOutput>;

export const SkillsApprovedCapsRevokeOutputSchema = z.object({
  cleared: z.boolean(),
}) as unknown as ZodType<SkillsApprovedCapsRevokeOutput>;

// ---- skill_propose chokepoint (TASK-74, out-of-git Part D) -----------------
//
// `skills:propose` is the single write chokepoint for agent-authored skills.
// The runner (via the skill.propose IPC action → host handler) hands the host a
// structurally-validated bundle; the host re-validates, fires the `skills:scan`
// veto/scan hook, runs the materialization gate (propose-gate.ts — origin + scan
// only now that a skill declares no caps), and writes ONE skills_v1_authored
// row. Storage-agnostic: no row/blob/git vocab.
//
// `origin` is the trust provenance ('authored' from the runner; 'imported' /
// 'attached' reserved for host-side flows). `files` are the bundle EXTRA files
// (host writes them to the blob store).
//
// TASK-100 — `capabilityProposal` is DEPRECATED and IGNORED by the host: a skill
// manifest no longer declares capabilities (its reach is the connectors it
// references), so there is nothing to propose. The field is retained on the wire
// (the runner sends an empty `Capabilities`) for IPC-schema stability; the host
// gate keys only on origin + scan. A skill that wants reach authors a connector
// (the connector-propose flow), which is gated by the connector approval card.

export interface SkillsProposeInput {
  ownerUserId: string;
  agentId: string;
  manifestYaml: string;
  bodyMd: string;
  files: BundleFile[];
  /** @deprecated TASK-100 — ignored by the host (a skill declares no caps). */
  capabilityProposal: SkillCapabilities;
  origin: 'authored' | 'imported' | 'attached';
}
export interface SkillsProposeOutput {
  skillId: string;
  status: 'active' | 'pending' | 'quarantined';
  /** A short, model-safe reason on a quarantine (or a structural reject). */
  reason?: string;
}

export const SkillsProposeOutputSchema = z.object({
  skillId: z.string(),
  status: z.union([z.literal('active'), z.literal('pending'), z.literal('quarantined')]),
  reason: z.string().optional(),
}) as unknown as ZodType<SkillsProposeOutput>;

// `skills:list-authored` — the read backing for agents:resolve-authored-skills.
// Returns the agent's authored skills (any status; the projection filters). The
// payload carries the manifest/body/files + the gate status + scan reason —
// storage-agnostic (no bundle_tree_sha / row vocab on the wire).
export interface SkillsListAuthoredInput {
  ownerUserId: string;
  agentId: string;
}
export interface AuthoredSkillProjection {
  skillId: string;
  description: string;
  manifestYaml: string;
  bodyMd: string;
  files: BundleFile[];
  status: 'active' | 'pending' | 'quarantined';
  reason?: string;
}
export interface SkillsListAuthoredOutput {
  skills: AuthoredSkillProjection[];
}

export const SkillsListAuthoredOutputSchema = z.object({
  skills: z.array(
    z.object({
      skillId: z.string(),
      description: z.string(),
      manifestYaml: z.string(),
      bodyMd: z.string(),
      files: z.array(z.object({ path: z.string(), contents: z.string() })),
      status: z.union([z.literal('active'), z.literal('pending'), z.literal('quarantined')]),
      reason: z.string().optional(),
    }),
  ),
}) as unknown as ZodType<SkillsListAuthoredOutput>;

// `GET /settings/skills/authored` listing (TASK-85). The user-facing "My Skills"
// panel surfaces the caller's agent-authored skills (across their personal
// agents) alongside their catalog skills. This is a SUMMARY surface — no manifest
// /body bytes — so the listing carries only the display fields + the owning
// agent + the lifecycle status. Quarantined drafts are excluded by the route
// (not user-facing "installed" skills); only `active` + `pending` are listed.
export interface AuthoredSkillListing {
  skillId: string;
  /** The personal agent this skill was authored for. */
  agentId: string;
  description: string;
  /** Lifecycle status: `active` (live) or `pending` (awaiting human approval). */
  status: 'active' | 'pending';
  /**
   * JIT discoverability (TASK-83). A SUMMARY of the capabilities a `pending`
   * cap-bearing skill is waiting on a human to approve — the same hosts/slots/
   * packages the just-in-time approval card would show on first use. Present
   * ONLY for a `pending` skill whose manifest declares at least one of these
   * (hosts, credential slots, or package egress); omitted for an inert pending
   * skill (nothing to approve) and for every `active` skill (already approved).
   *
   * This is public manifest data only — hostnames + slot NAMES, NEVER a secret
   * (the secret posts straight to the host credential store, never crossing
   * this read surface). It drives the "approve early" affordance in My Skills so
   * a user can approve + enter a key BEFORE the agent's first use, instead of
   * waiting for the JIT card to fire on the first `request_capability`.
   *
   * `slots[].account` (JIT P2) tags a slot to the user's shared service vault;
   * `slots[].haveExisting` is true when that vault entry already exists, so the
   * affordance offers "use your existing key" with no re-entry.
   */
  pendingCapabilities?: {
    hosts: string[];
    slots: Array<{ slot: string; kind: 'api-key'; account?: string; haveExisting?: boolean }>;
    packages: { npm: string[]; pypi: string[] };
  };
}
export interface SettingsAuthoredSkillsOutput {
  skills: AuthoredSkillListing[];
}

// `skills:scan` — the subscriber-hook home of the validator-skill veto/scan
// (TASK-74). Fired by `skills:propose` BEFORE the gate classifies. A subscriber
// (e.g. @ax/validator-skill) inspects the untrusted bundle text and returns a
// verdict. Storage/transport-agnostic: just the skill bundle text, NOT a git
// FileChange[]. NOTE this is a SERVICE hook (one authoritative scanner) — the
// host calls it and reads back the verdict; a missing scanner degrades to
// 'clean' (the regex floor is then skipped, matching the pre-TASK-74 no-LLM
// degrade). The veto is accept-but-annotate: a 'hit' quarantines, never throws.
export interface SkillsScanInput {
  skillId: string;
  manifestYaml: string;
  bodyMd: string;
  files: BundleFile[];
}
export interface SkillsScanOutput {
  /** 'clean' = no safety concern; 'hit' = quarantine with `reason`. */
  verdict: 'clean' | 'hit';
  reason?: string;
}

export const SkillsScanOutputSchema = z.object({
  verdict: z.union([z.literal('clean'), z.literal('hit')]),
  reason: z.string().optional(),
}) as unknown as ZodType<SkillsScanOutput>;

// `skills:proposed` — fire-and-forget notify the host emits AFTER a successful
// `skills:propose` write, so the orchestrator can mark the proposing
// conversation's warm session dirty (re-spawn next turn — a freshly-active
// skill is only visible at the next spawn, design §D6). Ids only; storage-
// agnostic. Replaces the `.ax/draft-skills` `workspace:applied` re-spawn trigger.
export interface SkillsProposedEvent {
  ownerUserId: string;
  agentId: string;
  skillId: string;
  status: 'active' | 'pending' | 'quarantined';
}

// `skills:authored-activate` — flip a `pending` authored skill's row to `active`
// once a human has approved its capabilities (design §D3: "on approve … flips to
// active"). Called by the orchestrator's authored-grant flow AFTER it writes the
// approved-caps rows. Idempotent + status-guarded: only a `pending` row flips
// (a `quarantined` row stays quarantined — approval never un-quarantines a
// flagged bundle; an already-`active` row is a no-op). Ids only; storage-
// agnostic (no row/blob/git vocab). `activated` reports whether THIS call flipped
// a pending row (false = already active / quarantined / no such row).
export interface SkillsAuthoredActivateInput {
  ownerUserId: string;
  agentId: string;
  skillId: string;
}
export interface SkillsAuthoredActivateOutput {
  activated: boolean;
}

export const SkillsAuthoredActivateOutputSchema = z.object({
  activated: z.boolean(),
}) as unknown as ZodType<SkillsAuthoredActivateOutput>;

// `skills:adopt-authored` — copy an agent-authored draft into the caller's OWN
// editable user-scoped skill, then mark the draft adopted (TASK-134, adopt-&-edit;
// design card 11). This replaces the admin-only "promote with admin-chosen grants"
// affordance for the user's own authored work: the user takes a copy they own and
// edits it in the form-first editor. The whole transaction is one hook so the
// copy + the mark are atomic.
//
// Reach posture (security): the adopted copy is upserted through `skills:upsert`
// scope:'user', which runs the FULL `parseSkillManifest` gate — a draft whose
// frontmatter still declares a capability block (allowedHosts / credentials /
// mcpServers / packages) HARD-FAILS the parse and the adopt errors out. So the
// user-owned copy can never carry self-granted reach; a skill's reach lives only
// on the connectors it references, re-consented via the connector approval path.
//
// Idempotent on the draft mark (status-guarded in the store) but NOT on the copy
// (a re-adopt re-upserts the same user skill, last-write-wins). `ownerUserId` is
// host-forced from the session at the route; never a client field. Ids only —
// storage-agnostic (no row/blob/git vocab on the wire).
export interface SkillsAdoptAuthoredInput {
  ownerUserId: string;
  agentId: string;
  skillId: string;
}
export interface SkillsAdoptAuthoredOutput {
  /** The id of the user-scoped skill the draft was copied into. */
  skillId: string;
  /** Whether the user-scoped copy was created (false = it already existed and was overwritten). */
  created: boolean;
  /** Whether THIS call flipped the draft to `adopted` (false = already adopted / not user-facing). */
  adopted: boolean;
}

export const SkillsAdoptAuthoredOutputSchema = z.object({
  skillId: z.string(),
  created: z.boolean(),
  adopted: z.boolean(),
}) as unknown as ZodType<SkillsAdoptAuthoredOutput>;
