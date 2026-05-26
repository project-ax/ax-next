/**
 * @ax/skills public hook payload types.
 *
 * Inter-plugin API. A future @ax/skills-fs (file-backed impl) would
 * register the same `skills:*` service hooks with these exact shapes —
 * no field here mentions postgres, rows, or any storage detail.
 */

import { z, type ZodType } from 'zod';
import type { SkillCapabilities } from '@ax/skills-parser';
export type { CapabilitySlot, McpServerSpec, SkillCapabilities } from '@ax/skills-parser';

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

export interface SkillDetail extends SkillSummary {
  bodyMd: string;
  manifestYaml: string;
}

export interface ResolvedSkill {
  id: string;
  capabilities: SkillCapabilities;
  bodyMd: string;
  manifestYaml: string;
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

const SkillDetailSchema = SkillSummarySchema.extend({
  bodyMd: z.string(),
  manifestYaml: z.string(),
});

const ResolvedSkillSchema = z.object({
  id: z.string(),
  capabilities: SkillCapabilitiesSchema,
  bodyMd: z.string(),
  manifestYaml: z.string(),
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
