import { z } from 'zod';
import { SharedFolderIdSchema } from '@ax/sandbox-protocol';

// ---------------------------------------------------------------------------
// Service contracts for @ax/shared-folders. `authorize-mounts` and the
// provider's `sandbox:delete-shared-folder` are typed in
// @ax/sandbox-mount-protocol (so resolvers can import them without importing
// this plugin); everything here is this plugin's own surface.
//
// Every input is validated STRICTLY (unknown keys rejected): the actor is
// `ctx.userId`, never a payload field, so a payload that tries to carry one is
// a caller bug worth failing loudly on.
// ---------------------------------------------------------------------------

const AgentIdSchema = z.string().min(1).max(256);

export const CreateInputSchema = z.object({ ownerAgentId: AgentIdSchema }).strict();
export type SharedFoldersCreateInput = z.infer<typeof CreateInputSchema>;
export interface SharedFoldersCreateOutput {
  folderId: string;
}
export const CreateOutputSchema = z.object({ folderId: SharedFolderIdSchema });

export const GrantInputSchema = z
  .object({
    folderId: SharedFolderIdSchema,
    agentId: AgentIdSchema,
    // 'owner' is deliberately absent: ownership only moves by agent deletion
    // (§3.7), never by a grant, so a grant can never make a second owner.
    role: z.enum(['editor', 'viewer']),
  })
  .strict();
export type SharedFoldersGrantInput = z.infer<typeof GrantInputSchema>;
export interface SharedFoldersGrantOutput {
  /** False when the agent already held exactly this role. */
  changed: boolean;
}
export const GrantOutputSchema = z.object({ changed: z.boolean() });

export const RevokeInputSchema = z
  .object({ folderId: SharedFolderIdSchema, agentId: AgentIdSchema })
  .strict();
export type SharedFoldersRevokeInput = z.infer<typeof RevokeInputSchema>;
export interface SharedFoldersRevokeOutput {
  /** False when the agent held no grant on the folder. */
  revoked: boolean;
}
export const RevokeOutputSchema = z.object({ revoked: z.boolean() });

export const DeleteInputSchema = z.object({ folderId: SharedFolderIdSchema }).strict();
export type SharedFoldersDeleteInput = z.infer<typeof DeleteInputSchema>;
export interface SharedFoldersDeleteOutput {
  deleted: true;
}
export const DeleteOutputSchema = z.object({ deleted: z.literal(true) });

export const ListInputSchema = z.object({ agentId: AgentIdSchema }).strict();
export type SharedFoldersListInput = z.infer<typeof ListInputSchema>;
export interface SharedFoldersListOutput {
  folders: { folderId: string; role: 'owner' | 'editor' | 'viewer'; createdAt: string }[];
}
export const ListOutputSchema = z.object({
  folders: z.array(
    z.object({
      folderId: SharedFolderIdSchema,
      role: z.enum(['owner', 'editor', 'viewer']),
      createdAt: z.string(),
    }),
  ),
});

/**
 * `folderIds` entries are NOT shape-checked by the schema: a malformed id is
 * dropped by the handler (the contract says an unknown/invalid id is simply
 * absent, never an error). The list length is bounded so a caller can't make
 * one session open run an unbounded query.
 */
export const AuthorizeMountsInputSchema = z
  .object({
    agentId: AgentIdSchema,
    folderIds: z.array(z.string()).max(256),
  })
  .strict();
export const AuthorizeMountsOutputSchema = z.object({
  folders: z.array(z.object({ folderId: SharedFolderIdSchema, readOnly: z.boolean() })),
});

/**
 * Payload of `shared-folders:access-reduced`, fired AFTER the change commits.
 * `agentIds` are the agents whose access to `folderId` was removed or narrowed.
 */
export interface SharedFoldersAccessReducedEvent {
  folderId: string;
  agentIds: string[];
}
