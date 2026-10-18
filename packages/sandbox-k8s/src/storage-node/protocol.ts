import { z } from 'zod';
import { BootstrapAssignmentSchema, SharedFolderIdSchema } from '@ax/sandbox-protocol';
import { MAX_CHANGE_COUNT, MAX_CHANGE_FILE_BYTES, MAX_CHANGE_TOTAL_BYTES } from '@ax/user-files-read';

export const STORAGE_FINALIZER = 'ax.io/storage-cleanup';
export const LATE_VOLUME = 'ax-late';
export const CLAIM_POOL_LABEL = 'ax.io/shared-pool';
export const CLAIM_AGENT_LABEL = 'ax.io/agent-id';
export const STANDBY_LABEL = 'ax.io/shared-standby';
/** W2 §3.8.1 — the host's decision of which shared folders a claim may bind. */
export const CLAIM_SHARED_FOLDERS_ANNOTATION = 'ax.io/shared-folders';
export const MAX_SHARED_FOLDERS = 16;
const name = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const uid = z.string().uuid();
export const StorageIdentitySchema = z.object({
  podName: name, podUid: uid, claimName: name, claimUid: uid,
  sandboxName: name, sandboxUid: uid,
}).strict();
export type StorageIdentity = z.infer<typeof StorageIdentitySchema>;
/**
 * One encoding only: present means non-empty, strictly sorted by id (so also
 * unique). The host omits the field when a session has no shared folders, so
 * an assignment without them is byte-identical to one from before W2.
 */
export const SharedFoldersSchema = z.array(z.object({ folderId: SharedFolderIdSchema, readOnly: z.boolean() }).strict())
  .min(1).max(MAX_SHARED_FOLDERS)
  .refine(list => list.every((f, i) => i === 0 || list[i - 1]!.folderId < f.folderId), 'shared folders must be sorted and unique');
export type SharedFolders = z.infer<typeof SharedFoldersSchema>;
/** Canonical JSON: the claim annotation and the request must match byte for byte. */
export const canonicalSharedFolders = (list: SharedFolders): string =>
  JSON.stringify(list.map(({ folderId, readOnly }) => ({ folderId, readOnly })));
export const StorageAssignmentSchema = StorageIdentitySchema.extend({
  backingProfile: z.string().regex(/^[0-9a-f]{64}$/),
  agentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  roles: z.array(z.enum(['user-files', 'memory'])).max(2),
  sharedFolders: SharedFoldersSchema.optional(),
  bootstrap: BootstrapAssignmentSchema,
}).strict().superRefine((v, ctx) => {
  if (new Set(v.roles).size !== v.roles.length || v.bootstrap.instanceId !== v.podUid) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid storage assignment' });
  }
});
export type StorageAssignment = z.infer<typeof StorageAssignmentSchema>;
export const StorageRecordSchema = StorageIdentitySchema.extend({
  backingProfile: z.string().regex(/^[0-9a-f]{64}$/),
  agentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  roles: z.array(z.enum(['user-files', 'memory'])).max(2),
  sharedFolders: SharedFoldersSchema.optional(),
  assignmentId: uid,
  published: z.boolean(),
}).strict();
export type StorageRecord = z.infer<typeof StorageRecordSchema>;

// An operator-readable recovery intent. Never serialize assignment bootstrap/env.
export const STORAGE_RECOVERY = 'ax.io/storage-recovery';
export const NodeFenceSchema = z.object({ machineId: uid, bootId: uid }).strict();
export type NodeFence = z.infer<typeof NodeFenceSchema>;
export const StorageRecoverySchema = z.object({ version: z.literal(1), fence: NodeFenceSchema,
  record: StorageRecordSchema }).strict();

// ---------------------------------------------------------------------------
// W3c — `/change-shared`: the host's writes into one shared folder
// (`sandbox:change-shared-folder`). The hook carries bytes; this wire carries
// them as base64, and this schema is the ONLY place that shape exists.
//
// Every cap is enforced here, before the engine sees the request, and again
// by `changeConfinedByWalk` (which also validates every path).
// ---------------------------------------------------------------------------

/** Longest change path on the wire. The walk's own rules (≤ 32 parts, no `..`) still apply. */
export const CHANGE_SHARED_MAX_PATH_CHARS = 1024;
/** base64 length of `bytes` bytes (padded). */
export const base64Length = (bytes: number): number => 4 * Math.ceil(bytes / 3);
/**
 * Request body cap for `/change-shared`: every written byte base64-inflated,
 * plus room for 64 changes' JSON (a 1 KiB path, escaped, plus field names and
 * hashes) — 512 KiB. Every other route keeps `STORAGE_REQUEST_MAX_BYTES`.
 */
export const CHANGE_SHARED_REQUEST_MAX_BYTES = base64Length(MAX_CHANGE_TOTAL_BYTES) + 512 * 1024;
/** Response cap: up to 64 results, each echoing a path of up to 1 KiB (escaped). */
export const CHANGE_SHARED_RESPONSE_MAX_BYTES = 256 * 1024;

/**
 * Canonical, padded base64 of at most the per-file cap, decoded to bytes.
 * Canonical by round trip (Node's decoder is lenient and skips junk), not by
 * a regex: a backtracking regex over a 14 MB string is a stack hazard.
 */
const ContentSchema = z.string().max(base64Length(MAX_CHANGE_FILE_BYTES)).transform((s, ctx) => {
  const bytes = Buffer.from(s, 'base64');
  if (bytes.toString('base64') !== s) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'content is not base64' }); return z.NEVER; }
  if (bytes.length > MAX_CHANGE_FILE_BYTES) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'content too large' }); return z.NEVER; }
  return bytes;
});
const ChangePathSchema = z.string().max(CHANGE_SHARED_MAX_PATH_CHARS);
const ChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('write'), path: ChangePathSchema, content: ContentSchema,
    ifMatch: z.string().regex(/^[0-9a-f]{64}$/).optional(), ifAbsent: z.literal(true).optional() }).strict(),
  z.object({ op: z.literal('mkdir'), path: ChangePathSchema, ifAbsent: z.literal(true).optional() }).strict(),
  z.object({ op: z.literal('delete'), path: ChangePathSchema }).strict(),
]);
export const ChangeSharedRequestSchema = z.object({
  folderId: SharedFolderIdSchema,
  createFolder: z.literal(true).optional(),
  changes: z.array(ChangeSchema).max(MAX_CHANGE_COUNT),
}).strict().superRefine((v, ctx) => {
  let total = 0;
  for (const change of v.changes) {
    if (change.op !== 'write') continue;
    total += change.content.length;
    if (change.ifMatch !== undefined && change.ifAbsent) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ifMatch and ifAbsent cannot both be set' });
    }
  }
  if (total > MAX_CHANGE_TOTAL_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'changes too large' });
});
export type ChangeSharedRequest = z.infer<typeof ChangeSharedRequestSchema>;
/** The wire request before parsing: what the client sends. */
export type ChangeSharedWireRequest = z.input<typeof ChangeSharedRequestSchema>;

/**
 * Why the node refused a change request. `walk` codes come from
 * `WalkChangeError` (`link-or-not-dir`, `not-empty`, `is-directory`,
 * `invalid-change`, `too-large`, `too-many-changes`); `invalid-path` is a
 * malformed path; `missing-folder` is a folder that does not exist without
 * `createFolder`. Never a path: the code is the whole explanation.
 */
export const CHANGE_SHARED_REFUSALS = ['link-or-not-dir', 'not-empty', 'is-directory', 'invalid-change',
  'too-large', 'too-many-changes', 'invalid-path', 'missing-folder'] as const;
export type ChangeSharedRefusal = (typeof CHANGE_SHARED_REFUSALS)[number];
const ResultSchema = z.object({ path: z.string(),
  outcome: z.enum(['written', 'created', 'exists', 'deleted', 'absent', 'conflict']) }).strict();
export const ChangeSharedResponseSchema = z.union([
  z.object({ kind: z.literal('done'), results: z.array(ResultSchema).max(MAX_CHANGE_COUNT) }).strict(),
  z.object({ kind: z.literal('refused'), refused: z.enum(CHANGE_SHARED_REFUSALS),
    results: z.array(ResultSchema).max(MAX_CHANGE_COUNT) }).strict(),
]);
export type ChangeSharedResponse = z.infer<typeof ChangeSharedResponseSchema>;
