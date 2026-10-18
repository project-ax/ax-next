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

// ---- set-member (W3e §8) ----------------------------------------------------
/**
 * Add one of the person's agents to a project, change its role, or remove it
 * (`role: null`). The project's folder never crosses this surface: the plugin
 * maps project → folder itself and goes through `shared-folders:grant` /
 * `revoke` as the person, so W2's rules (same owner only, never the owner
 * agent) and its session reaping apply unchanged.
 */
export const SetMemberInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    agentId: AgentIdSchema,
    role: z.enum(['editor', 'viewer']).nullable(),
  })
  .strict();
export type ProjectsSetMemberInput = z.input<typeof SetMemberInputSchema>;
export const SetMemberOutputSchema = z.object({
  /** The project's members after the change, as `projects:get` returns them. */
  members: z.array(MemberSchema),
});
export type ProjectsSetMemberOutput = z.infer<typeof SetMemberOutputSchema>;

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

// ---- read-file / download-file (W3b §5.1) ----------------------------------
// Host-internal (channel-web's project routes call them; never an IPC action).
// `path` is relative to the project's folder ('' = the folder itself). It is
// caller-supplied and the folder is agent-written: the sandbox provider's
// confined walk rejects `..`, absolute paths and symlinks at any depth. The
// folder's id NEVER appears in an output — the browser has no use for it, and
// it is the key the grant-free sandbox read takes.

/** Most bytes of a file `projects:read-file` returns (a preview). */
export const READ_FILE_PREVIEW_MAX_BYTES = 1_048_576;
/** Most entries in one `projects:read-file` listing (channel-web's `USER_FILES_ENTRIES_MAX`). */
export const READ_FILE_MAX_ENTRIES = 500;
/** Largest file `projects:download-file` returns; bigger is `too-large`, never truncated. */
export const DOWNLOAD_FILE_MAX_BYTES = 10_485_760;

const RelPathSchema = z.string().max(4096);
/** Bytes (a Buffer is one too). `z.custom`, not `z.instanceof`, to keep the `ArrayBufferLike` type. */
const BytesSchema = z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'expected bytes');

export const ReadFileInputSchema = z.object({ projectId: ProjectIdSchema, path: RelPathSchema }).strict();
export type ProjectsReadFileInput = z.input<typeof ReadFileInputSchema>;
const FileEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(['file', 'dir']),
  size: z.number().optional(),
  updatedAt: z.string().optional(),
});
export type ProjectFileEntry = z.infer<typeof FileEntrySchema>;
export const ReadFileOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dir'), entries: z.array(FileEntrySchema), truncated: z.boolean() }),
  z.object({
    kind: z.literal('file'),
    contents: BytesSchema,
    /** `contents` is the first 1 MiB of a longer file. */
    truncated: z.boolean(),
    /** The whole file's size in bytes. */
    size: z.number(),
    /**
     * Lowercase hex sha256 of `contents` — the base hash `projects:write-file`
     * takes. Omitted when `truncated`: a preview's hash isn't the file's, and
     * the editor only opens files that fit in one preview.
     */
    sha256: z.string().optional(),
  }),
  z.object({ kind: z.literal('absent') }),
  /** This deployment can't read project folders on the host (no reader, or no mount). */
  z.object({ kind: z.literal('unavailable') }),
]);
export type ProjectsReadFileOutput = z.infer<typeof ReadFileOutputSchema>;

export const DownloadFileInputSchema = z.object({ projectId: ProjectIdSchema, path: RelPathSchema }).strict();
export type ProjectsDownloadFileInput = z.input<typeof DownloadFileInputSchema>;
export const DownloadFileOutputSchema = z.object({ contents: BytesSchema, size: z.number() });
export type ProjectsDownloadFileOutput = z.infer<typeof DownloadFileOutputSchema>;

/**
 * The `PluginError` codes `projects:download-file` refuses with (besides
 * `invalid-payload`). Each maps to one HTTP answer:
 * - `not-found` — no such project, one the person can't use, OR no file at
 *   that path. One code and one message for all three, so a download can't
 *   probe for projects.
 * - `not-a-file` — the path is a folder.
 * - `too-large` — over {@link DOWNLOAD_FILE_MAX_BYTES}. No bytes are returned.
 * - `unavailable` — this deployment can't read project folders on the host.
 */
export type ProjectsDownloadRefusal = 'not-found' | 'not-a-file' | 'too-large' | 'unavailable';

// ---- write-file / delete-file / create-folder (W3c §6) ----------------------
// Host-internal, like read-file. The person must be able to use a member agent
// whose role is editor or owner. `path` is relative to the project's folder,
// never '' and never `sources/` (read-only; W5 fills it). The sandbox
// provider's confined walk does the change; this plugin decides who and where.

/** Largest file `projects:write-file` saves (the provider's per-file cap). */
export const WRITE_FILE_MAX_BYTES = 10_485_760;

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex sha256');

export const WriteFileInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    path: RelPathSchema,
    content: BytesSchema,
    /** sha256 of the bytes the person last read; anything else on disk is a `conflict`. */
    baseHash: Sha256HexSchema.optional(),
    /** Create only: an existing name is `exists`. */
    ifAbsent: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => !(v.baseHash !== undefined && v.ifAbsent !== undefined), {
    message: 'pass baseHash or ifAbsent, not both',
  });
export type ProjectsWriteFileInput = z.input<typeof WriteFileInputSchema>;
export const WriteFileOutputSchema = z.object({ sha256: z.string() });
export type ProjectsWriteFileOutput = z.infer<typeof WriteFileOutputSchema>;

export const DeleteFileInputSchema = z.object({ projectId: ProjectIdSchema, path: RelPathSchema }).strict();
export type ProjectsDeleteFileInput = z.input<typeof DeleteFileInputSchema>;
export const DeleteFileOutputSchema = z.object({});
export type ProjectsDeleteFileOutput = z.infer<typeof DeleteFileOutputSchema>;

export const CreateFolderInputSchema = z.object({ projectId: ProjectIdSchema, path: RelPathSchema }).strict();
export type ProjectsCreateFolderInput = z.input<typeof CreateFolderInputSchema>;
export const CreateFolderOutputSchema = z.object({});
export type ProjectsCreateFolderOutput = z.infer<typeof CreateFolderOutputSchema>;

/**
 * The `PluginError` codes the change hooks refuse with (set as both `code`
 * and `reasonCode`), besides `invalid-payload` (a bad path or input),
 * `not-found` (no such project, one the person can't use, or — delete only —
 * nothing at the path) and `forbidden` (the person can use the project only
 * through viewer agents):
 * - `conflict` — the file changed since `baseHash` was read (or is gone).
 * - `exists` — `ifAbsent` and something is already there.
 * - `protected-path` — deleting `instructions.md` or `memory/status.md`.
 * - `read-only-path` — anything in `sources/`.
 * - `too-large` — over {@link WRITE_FILE_MAX_BYTES}.
 * - `files-unavailable` — this deployment can't write project folders.
 */
export type ProjectsChangeRefusal =
  | 'conflict'
  | 'exists'
  | 'protected-path'
  | 'read-only-path'
  | 'too-large'
  | 'files-unavailable';
