/**
 * @ax/teams public hook payload types.
 *
 * These shapes are the inter-plugin API. A future @ax/teams-ldap or
 * @ax/teams-saml-groups would register the same `teams:*` service hooks
 * with these exact payload types — no field here mentions postgres,
 * SCIM, or IdP-specific vocabulary. `team_id`, `user_id`, `role`, and
 * `display_name` are all generic.
 */

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
