import { z } from 'zod';
import { BootstrapAssignmentSchema, SharedFolderIdSchema } from '@ax/sandbox-protocol';

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
