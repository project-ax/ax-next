import { z } from 'zod';
import { BootstrapAssignmentSchema } from '@ax/sandbox-protocol';

export const STORAGE_FINALIZER = 'ax.io/storage-cleanup';
export const LATE_VOLUME = 'ax-late';
export const CLAIM_POOL_LABEL = 'ax.io/shared-pool';
export const CLAIM_AGENT_LABEL = 'ax.io/agent-id';
export const SESSION_ID_ANNOTATION = 'ax.io/session-id';
export const STANDBY_LABEL = 'ax.io/shared-standby';
const name = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const uid = z.string().uuid();
export const StorageIdentitySchema = z.object({
  podName: name, podUid: uid, claimName: name, claimUid: uid,
  sandboxName: name, sandboxUid: uid,
}).strict();
export type StorageIdentity = z.infer<typeof StorageIdentitySchema>;
export const StorageAssignmentSchema = StorageIdentitySchema.extend({
  backingProfile: z.string().regex(/^[0-9a-f]{64}$/),
  agentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  roles: z.array(z.enum(['user-files', 'memory'])).max(2),
  bootstrap: BootstrapAssignmentSchema,
}).strict().superRefine((v, ctx) => {
  if (new Set(v.roles).size !== v.roles.length || v.bootstrap.instanceId !== v.podUid) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid storage assignment' });
  }
});
export type StorageAssignment = z.infer<typeof StorageAssignmentSchema>;
/**
 * W2 legacy (TASK-904). A W2-era helper (#989, reverted) bound shared folders at
 * `ax-late/shared/<folderId>` and named them here. Nothing binds one any more, and
 * an assignment may not carry the key. A record may, and release unmounts those
 * binds, so a helper upgraded over a live W2 session leaves no bind behind. Delete
 * this once no W2-era ledger record or recovery annotation can exist (production
 * reset and drained, §11 step 3).
 */
const LEGACY_SHARED_FOLDER_ID_RE = /^sf_[A-Za-z0-9_-]{1,64}$/;
export const isLegacySharedFolderId = (id: unknown): id is string =>
  typeof id === 'string' && LEGACY_SHARED_FOLDER_ID_RE.test(id);
const LegacySharedFoldersSchema = z.array(z.object({
  folderId: z.string().regex(LEGACY_SHARED_FOLDER_ID_RE), readOnly: z.boolean() }).strict())
  .min(1).max(16)
  .refine(list => list.every((f, i) => i === 0 || list[i - 1]!.folderId < f.folderId), 'shared folders must be sorted and unique');
export const StorageRecordSchema = StorageIdentitySchema.extend({
  backingProfile: z.string().regex(/^[0-9a-f]{64}$/),
  agentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  roles: z.array(z.enum(['user-files', 'memory'])).max(2),
  sharedFolders: LegacySharedFoldersSchema.optional(),
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
