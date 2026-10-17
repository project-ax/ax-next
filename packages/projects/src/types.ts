import { z } from 'zod';

// ---------------------------------------------------------------------------
// Service contracts for @ax/projects (W3 spec §4.1–§4.3).
//
// Every input is validated STRICTLY (unknown keys rejected): the actor is
// `ctx.userId`, never a payload field, so a payload that tries to carry one is
// a caller bug worth failing loudly on.
//
// The name and description are person-written but reach other members' agents
// in the project block (§4.6), so they are normalized here, once, before they
// are stored: the name is a single line, the description has no control
// characters except newlines and tabs.
// ---------------------------------------------------------------------------

const AgentIdSchema = z.string().min(1).max(256);
/** Lenient on purpose: a malformed id is just an unknown project (`not-found`). */
const ProjectIdSchema = z.string().min(1).max(128);

export const NAME_MAX_CHARS = 80;
export const DESCRIPTION_MAX_CHARS = 500;

/** Any C0/C1 control (newlines included) or a Unicode line/paragraph separator. */
const NAME_FORBIDDEN = /[\p{Cc}\u2028\u2029]/u;
/** Same, except `\n` and `\t` are allowed. `\r` is normalized away before this runs. */
const DESCRIPTION_FORBIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/;

export const NameSchema = z
  .string()
  .trim()
  .min(1, 'name must not be empty')
  .max(NAME_MAX_CHARS, `name must be at most ${NAME_MAX_CHARS} characters`)
  .refine((s) => !NAME_FORBIDDEN.test(s), 'name must be one line with no control characters');

/** Trimmed; `\r\n` / `\r` become `\n`; empty after trimming means "no description" (null). */
export const DescriptionSchema = z
  .string()
  .transform((s) => s.replace(/\r\n?/g, '\n').trim())
  .pipe(
    z
      .string()
      .max(DESCRIPTION_MAX_CHARS, `description must be at most ${DESCRIPTION_MAX_CHARS} characters`)
      .refine((s) => !DESCRIPTION_FORBIDDEN.test(s), 'description must have no control characters'),
  )
  .transform((s) => (s === '' ? null : s));

const RoleSchema = z.enum(['owner', 'editor', 'viewer']);
export type ProjectMemberRole = z.infer<typeof RoleSchema>;
const MemberSchema = z.object({ agentId: z.string(), role: RoleSchema });
export interface ProjectMember {
  agentId: string;
  role: ProjectMemberRole;
}

// ---- create ---------------------------------------------------------------
export const CreateInputSchema = z
  .object({
    ownerAgentId: AgentIdSchema,
    name: NameSchema,
    description: DescriptionSchema.optional(),
  })
  .strict();
export type ProjectsCreateInput = z.input<typeof CreateInputSchema>;
export const CreateOutputSchema = z.object({ projectId: z.string(), folderId: z.string() });
export type ProjectsCreateOutput = z.infer<typeof CreateOutputSchema>;

// ---- list -----------------------------------------------------------------
export const ListInputSchema = z.object({}).strict();
export type ProjectsListInput = z.input<typeof ListInputSchema>;
export const ListOutputSchema = z.object({
  projects: z.array(
    z.object({
      projectId: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      updatedAt: z.string(),
      /** Only the member agents the actor can use, with their roles. */
      members: z.array(MemberSchema),
    }),
  ),
});
export type ProjectsListOutput = z.infer<typeof ListOutputSchema>;

// ---- get ------------------------------------------------------------------
export const GetInputSchema = z.object({ projectId: ProjectIdSchema }).strict();
export type ProjectsGetInput = z.input<typeof GetInputSchema>;
export const GetOutputSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  folderId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Owner first, then by grant age (the folder's member list). */
  members: z.array(MemberSchema),
});
export type ProjectsGetOutput = z.infer<typeof GetOutputSchema>;

// ---- update ---------------------------------------------------------------
export const UpdateInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    name: NameSchema.optional(),
    /** A string replaces it; `null` (or a blank string) clears it. */
    description: DescriptionSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'nothing to update: pass name and/or description',
  });
export type ProjectsUpdateInput = z.input<typeof UpdateInputSchema>;
export const UpdateOutputSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  updatedAt: z.string(),
});
export type ProjectsUpdateOutput = z.infer<typeof UpdateOutputSchema>;

// ---- delete ---------------------------------------------------------------
export const DeleteInputSchema = z.object({ projectId: ProjectIdSchema }).strict();
export type ProjectsDeleteInput = z.input<typeof DeleteInputSchema>;
export const DeleteOutputSchema = z.object({ deleted: z.literal(true) });
export type ProjectsDeleteOutput = z.infer<typeof DeleteOutputSchema>;

// ---- resolve --------------------------------------------------------------
export const ResolveInputSchema = z.object({ projectId: ProjectIdSchema, agentId: AgentIdSchema }).strict();
export type ProjectsResolveInput = z.input<typeof ResolveInputSchema>;
export const ResolveOutputSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  folderId: z.string(),
  /** From the agent's grant: true for a viewer. */
  readOnly: z.boolean(),
});
export type ProjectsResolveOutput = z.infer<typeof ResolveOutputSchema>;

// ---- events ---------------------------------------------------------------
/**
 * Payload of `projects:deleted`, fired AFTER the project's row is deleted —
 * exactly once per row, by whichever path deleted it (`projects:delete` or the
 * `shared-folders:deleted` subscriber), since both use `DELETE … RETURNING`.
 * Subscribers (conversations purges the project's chats) should still be
 * idempotent: a fire is not transactional with the delete.
 */
export interface ProjectsDeletedEvent {
  projectId: string;
}
