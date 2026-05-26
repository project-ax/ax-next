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
export type { CapabilitySlot, McpServerSpec, SkillCapabilities } from '@ax/skills-parser';
export type { SkillTier } from './catalog-tier.js';

export interface SkillSummary {
  id: string;
  description: string;
  version: number;
  capabilities: SkillCapabilities;
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
  capabilities: SkillCapabilities;
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
const CapabilitySlotSchema = z.object({
  slot: z.string(),
  kind: z.literal('api-key'),
  description: z.string().optional(),
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

const SkillCapabilitiesSchema = z.object({
  allowedHosts: z.array(z.string()),
  credentials: z.array(CapabilitySlotSchema),
  mcpServers: z.array(McpServerSpecSchema),
  packages: z.object({
    npm: z.array(z.string()),
    pypi: z.array(z.string()),
  }),
});

const SkillSummarySchema = z.object({
  id: z.string(),
  description: z.string(),
  version: z.number(),
  capabilities: SkillCapabilitiesSchema,
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
  capabilities: SkillCapabilitiesSchema,
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
