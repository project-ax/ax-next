/**
 * @ax/teams public hook payload types.
 *
 * These shapes are the inter-plugin API. A future @ax/teams-ldap or
 * @ax/teams-saml-groups would register the same `teams:*` service hooks
 * with these exact payload types — no field here mentions postgres,
 * SCIM, or IdP-specific vocabulary. `team_id`, `user_id`, `role`, and
 * `display_name` are all generic.
 */

import { z, type ZodType } from 'zod';

export type TeamRole = 'admin' | 'member';

export interface Team {
  id: string;
  displayName: string;
  /** user_id of the team's creator. NOT a foreign-key (Invariant I4). */
  createdBy: string;
  createdAt: Date;
}

export interface Membership {
  teamId: string;
  userId: string;
  role: TeamRole;
  joinedAt: Date;
}

/**
 * Minimal actor shape — only the fields the teams plugin's authz logic
 * reads. Constructed by the admin endpoint handler from
 * `auth:require-user`'s output; tests construct it directly.
 *
 * Note: unlike @ax/agents, we do NOT carry `isAdmin` here. The teams
 * plugin's authz model is per-team-role-based — being a global app admin
 * does NOT automatically grant team-admin powers. Those are separate
 * privilege ladders. Admin endpoints in Task 13 may layer in app-admin
 * overrides at the route boundary if we decide we want them.
 */
export interface Actor {
  userId: string;
}

// --- Service hook payloads ---------------------------------------------------

export interface CreateTeamInput {
  actor: Actor;
  displayName: string;
}

export interface CreateTeamOutput {
  /** Creator becomes role='admin' atomically with the row insert. */
  team: Team;
}

export interface ListForUserInput {
  userId: string;
}

export interface ListForUserOutput {
  teams: Team[];
}

export interface IsMemberInput {
  teamId: string;
  userId: string;
}

/**
 * Internal hook (no caller-auth gate). Used by @ax/agents'
 * `checkAccess` to gate team-visibility agent reads. `role` is undefined
 * when the user is not a member — callers should NOT key off `role`
 * absence to mean "member with no role" (the role column has a NOT NULL
 * + CHECK constraint at the DB layer).
 */
export interface IsMemberOutput {
  member: boolean;
  role?: TeamRole;
}

export interface AddMemberInput {
  actor: Actor;
  teamId: string;
  userId: string;
  role: TeamRole;
}

export interface AddMemberOutput {
  membership: Membership;
}

export interface RemoveMemberInput {
  actor: Actor;
  teamId: string;
  userId: string;
}

export type RemoveMemberOutput = void;

export interface ListMembersInput {
  actor: Actor;
  teamId: string;
}

export interface ListMembersOutput {
  members: Membership[];
}

// ---------------------------------------------------------------------------
// Runtime `returns` contracts for the `teams:*` service hooks (ARCH-13).
//
// `teams:is-member` is the gate @ax/agents' `checkAccess` chains through for
// team-visibility agent reads, so a malformed membership flowing out is
// authz-relevant — same defense-in-depth motive as ARCH-6's agents:resolve.
//
// Storage-agnostic: field names mirror the public `Team`/`Membership`
// interfaces (no `team_id`/row vocab). `createdAt`/`joinedAt` are real `Date`
// instances (`z.date()`, NOT `z.string()`). `teams:remove-member` returns
// `void` and so gets no schema. Cast to `ZodType<…>` (zod's `.optional()`
// infers `| undefined` the interface won't directly absorb); the drift-guard
// test enforces field-for-field agreement.
// ---------------------------------------------------------------------------
const TeamRoleSchema = z.union([z.literal('admin'), z.literal('member')]);

const TeamSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  createdBy: z.string(),
  createdAt: z.date(),
});

const MembershipSchema = z.object({
  teamId: z.string(),
  userId: z.string(),
  role: TeamRoleSchema,
  joinedAt: z.date(),
});

export const CreateTeamOutputSchema = z.object({
  team: TeamSchema,
}) as unknown as ZodType<CreateTeamOutput>;

export const ListForUserOutputSchema = z.object({
  teams: z.array(TeamSchema),
}) as unknown as ZodType<ListForUserOutput>;

export const IsMemberOutputSchema = z.object({
  member: z.boolean(),
  role: TeamRoleSchema.optional(),
}) as unknown as ZodType<IsMemberOutput>;

export const AddMemberOutputSchema = z.object({
  membership: MembershipSchema,
}) as unknown as ZodType<AddMemberOutput>;

export const ListMembersOutputSchema = z.object({
  members: z.array(MembershipSchema),
}) as unknown as ZodType<ListMembersOutput>;
