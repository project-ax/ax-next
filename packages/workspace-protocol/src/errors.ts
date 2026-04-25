import { z } from 'zod';

// Wire-error envelope. Same shape as @ax/ipc-protocol's IpcErrorEnvelope, but
// we don't import that package — keeps workspace-protocol independent of the
// IPC protocol. Both packages happen to use this shape because it's the
// natural one for HTTP-JSON RPC error bodies.
export const WorkspaceErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    // Optional structured fields for parent-mismatch (the only error that
    // benefits from a machine-readable detail today).
    expectedParent: z.string().nullable().optional(),
    actualParent: z.string().nullable().optional(),
  }),
}).strict();

export type WorkspaceErrorEnvelope = z.infer<typeof WorkspaceErrorEnvelopeSchema>;
