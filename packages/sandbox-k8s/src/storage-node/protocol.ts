import { z } from 'zod';
import { BootstrapAssignmentSchema } from '@ax/sandbox-protocol';

export const STORAGE_FINALIZER = 'ax.io/storage-cleanup';
export const LATE_VOLUME = 'ax-late';
export const CLAIM_POOL_LABEL = 'ax.io/shared-pool';
export const CLAIM_AGENT_LABEL = 'ax.io/agent-id';
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
export const StorageRecordSchema = StorageIdentitySchema.extend({
  backingProfile: z.string().regex(/^[0-9a-f]{64}$/),
  agentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  roles: z.array(z.enum(['user-files', 'memory'])).max(2),
  assignmentId: uid,
  published: z.boolean(),
}).strict();
export type StorageRecord = z.infer<typeof StorageRecordSchema>;
