import { z } from 'zod';

export interface HostGrantsGrantInput {
  ownerUserId: string;
  agentId: string;
  host: string;
}
export interface HostGrantsGrantOutput {
  created: boolean;
}

export interface HostGrantsListInput {
  ownerUserId: string;
  agentId: string;
}
export interface HostGrantsListOutput {
  hosts: { host: string; grantedAt: string }[];
}

export interface HostGrantsRevokeInput {
  ownerUserId: string;
  agentId: string;
  host: string;
}
export interface HostGrantsRevokeOutput {
  revoked: boolean;
}

// TASK — Settings one-list view: every grant the user owns across ALL their
// agents, each row carrying its agentId.
export interface HostGrantsListForUserInput {
  ownerUserId: string;
}
export interface HostGrantsListForUserOutput {
  grants: { host: string; agentId: string; grantedAt: string }[];
}

export const HostGrantsGrantOutputSchema = z.object({ created: z.boolean() });
export const HostGrantsListOutputSchema = z.object({
  hosts: z.array(z.object({ host: z.string(), grantedAt: z.string() })),
});
export const HostGrantsListForUserOutputSchema = z.object({
  grants: z.array(
    z.object({ host: z.string(), agentId: z.string(), grantedAt: z.string() }),
  ),
});
export const HostGrantsRevokeOutputSchema = z.object({ revoked: z.boolean() });
