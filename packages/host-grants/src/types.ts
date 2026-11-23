import { z } from 'zod';

// TASK-1212 — an agent's allowed sites belong to the agent: `list` and `revoke`
// are keyed by agent alone. A personal agent's list is its owner's (only the
// owner can add to it); a team agent's is every member's adds.

export interface HostGrantsGrantInput {
  /** The person adding the site. Recorded as who added it, not whose it is. */
  ownerUserId: string;
  agentId: string;
  host: string;
}
export interface HostGrantsGrantOutput {
  /** False when the agent already had the host, whoever added it. */
  created: boolean;
}

export interface HostGrantsListInput {
  agentId: string;
}
export interface HostGrantsListOutput {
  /** One entry per host, whoever added it, with the earliest `grantedAt`
   *  (ISO-8601), ordered by host. */
  hosts: { host: string; grantedAt: string }[];
}

export interface HostGrantsRevokeInput {
  agentId: string;
  host: string;
}
export interface HostGrantsRevokeOutput {
  /** True when the agent had the host. It is gone for everyone: every adder's
   *  row for it is deleted. */
  revoked: boolean;
}

// TASK — Settings one-list view: every grant the user added across ALL their
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
