export { createTeamsPlugin, type CreateTeamsPluginOptions } from './plugin.js';
export {
  ADMIN_BODY_MAX_BYTES,
  createAdminTeamRouteHandlers,
  registerAdminTeamRoutes,
  type AdminRouteDeps,
  type RouteRequest,
  type RouteResponse,
} from './admin-routes.js';
export {
  runTeamsMigration,
  type MembershipRow,
  type TeamRow,
  type TeamsDatabase,
} from './migrations.js';
export {
  createTeamStore,
  mintTeamId,
  validateDisplayName,
  validateId,
  validateRole,
  type TeamStore,
} from './store.js';
export { scopedTeams, type TeamScope } from './scope.js';
export { requireAdmin } from './acl.js';
export type {
  Actor,
  AddMemberInput,
  AddMemberOutput,
  CreateTeamInput,
  CreateTeamOutput,
  IsMemberInput,
  IsMemberOutput,
  ListForUserInput,
  ListForUserOutput,
  ListMembersInput,
  ListMembersOutput,
  Membership,
  RemoveMemberInput,
  RemoveMemberOutput,
  Team,
  TeamRole,
} from './types.js';
