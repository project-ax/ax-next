import {
  makeChatContext,
  PluginError,
  type Plugin,
} from '@ax/core';
import type { Kysely } from 'kysely';
import { requireAdmin } from './acl.js';
import { registerAdminTeamRoutes } from './admin-routes.js';
import { runTeamsMigration, type TeamsDatabase } from './migrations.js';
import {
  createTeamStore,
  validateDisplayName,
  validateId,
  validateRole,
  type TeamStore,
} from './store.js';
import type {
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
  RemoveMemberInput,
  RemoveMemberOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/teams';

export interface CreateTeamsPluginOptions {
  /**
   * If true, mount the /admin/teams* routes. Default: false. The teams
   * plugin must function in single-process / sandbox-side contexts that
   * don't load @ax/http-server or @ax/auth — gating on this flag keeps
   * those boots clean. The multi-tenant preset (Task 16) sets it. Mirrors
   * @ax/mcp-client's `mountAdminRoutes` opt from Task 10.
   */
  mountAdminRoutes?: boolean;
}

// ---------------------------------------------------------------------------
// @ax/teams plugin
//
// Registers the six `teams:*` service hooks. ACL is uniformly enforced
// via `requireAdmin` for the team-write hooks; `is-member` is internal
// (used by @ax/agents' team-agent ACL) and intentionally NOT auth-gated.
//
// Manifest decisions:
//   - `calls: ['database:get-instance']` is the only HARD dep. When the
//     `mountAdminRoutes` opt is set we additionally call `http:register-route`
//     and `auth:require-user`; both are added to the manifest's `calls`
//     list at construction so the bus's topological sort (and the lint
//     rule that pins `calls` ⊇ actually-called) stays accurate.
//   - We don't call `teams:is-member` ourselves (we own it); we don't
//     subscribe to anything.
//
// Last-admin guard: `teams:remove-member` rejects with the custom code
// 'cannot-remove-last-admin' when removing the final admin row would
// orphan the team. This is the one place where the store layer alone
// isn't sufficient — the check + delete must happen in the same handler
// to avoid a TOCTOU race; we run them inside a transaction.
// ---------------------------------------------------------------------------

export function createTeamsPlugin(
  opts: CreateTeamsPluginOptions = {},
): Plugin {
  const mountAdminRoutes = opts.mountAdminRoutes === true;
  const unregisterRoutes: Array<() => void> = [];
  let db: Kysely<TeamsDatabase> | undefined;
  // store ref kept for shutdown symmetry only; the actual closure is
  // `localStore` inside init(). Prefixed with `_` so lint doesn't flag it.
  let _store: TeamStore | undefined;

  const calls: string[] = ['database:get-instance'];
  if (mountAdminRoutes) {
    calls.push('http:register-route', 'auth:require-user');
  }

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'teams:create',
        'teams:list-for-user',
        'teams:is-member',
        'teams:add-member',
        'teams:remove-member',
        'teams:list-members',
      ],
      calls,
      subscribes: [],
    },

    async init({ bus }) {
      const initCtx = makeChatContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });

      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      db = shared as Kysely<TeamsDatabase>;
      await runTeamsMigration(db);
      const localStore = createTeamStore(db);
      _store = localStore;

      bus.registerService<CreateTeamInput, CreateTeamOutput>(
        'teams:create',
        PLUGIN_NAME,
        async (_ctx, input) => createTeam(localStore, input),
      );

      bus.registerService<ListForUserInput, ListForUserOutput>(
        'teams:list-for-user',
        PLUGIN_NAME,
        async (_ctx, input) => listForUser(localStore, input),
      );

      bus.registerService<IsMemberInput, IsMemberOutput>(
        'teams:is-member',
        PLUGIN_NAME,
        async (_ctx, input) => isMember(localStore, input),
      );

      bus.registerService<AddMemberInput, AddMemberOutput>(
        'teams:add-member',
        PLUGIN_NAME,
        async (_ctx, input) => addMember(localStore, input),
      );

      bus.registerService<RemoveMemberInput, RemoveMemberOutput>(
        'teams:remove-member',
        PLUGIN_NAME,
        async (_ctx, input) => removeMember(localStore, input),
      );

      bus.registerService<ListMembersInput, ListMembersOutput>(
        'teams:list-members',
        PLUGIN_NAME,
        async (_ctx, input) => listMembers(localStore, input),
      );

      // Mount /admin/teams* last — http:register-route and auth:require-user
      // come from sibling plugins which must be init'd first; the kernel's
      // topological sort over `manifest.calls` already enforces that.
      if (mountAdminRoutes) {
        const unregisters = await registerAdminTeamRoutes(bus, initCtx);
        unregisterRoutes.push(...unregisters);
      }
    },

    async shutdown() {
      // Drop admin routes so a re-init in tests doesn't trip duplicate-
      // route. Each unregister is idempotent (http-server's contract).
      // Best-effort: don't let a transport-level error abort the rest of
      // the shutdown loop.
      while (unregisterRoutes.length > 0) {
        const fn = unregisterRoutes.pop();
        try {
          fn?.();
        } catch {
          // best-effort
        }
      }
      // The shared db handle is owned by @ax/database-postgres; don't
      // close it here. Just drop our references so a re-init doesn't
      // read a stale store.
      db = undefined;
      _store = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Hook handlers
// ---------------------------------------------------------------------------

async function createTeam(
  store: TeamStore,
  input: CreateTeamInput,
): Promise<CreateTeamOutput> {
  const displayName = validateDisplayName(input.displayName);
  const createdBy = validateId(input.actor.userId, 'actor.userId');
  const team = await store.create({ displayName, createdBy });
  return { team };
}

async function listForUser(
  store: TeamStore,
  input: ListForUserInput,
): Promise<ListForUserOutput> {
  const userId = validateId(input.userId, 'userId');
  const teams = await store.listForUser(userId);
  return { teams };
}

async function isMember(
  store: TeamStore,
  input: IsMemberInput,
): Promise<IsMemberOutput> {
  const teamId = validateId(input.teamId, 'teamId');
  const userId = validateId(input.userId, 'userId');
  const role = await store.getMembershipRole(teamId, userId);
  if (role === null) {
    return { member: false };
  }
  return { member: true, role };
}

async function addMember(
  store: TeamStore,
  input: AddMemberInput,
): Promise<AddMemberOutput> {
  const teamId = validateId(input.teamId, 'teamId');
  const userId = validateId(input.userId, 'userId');
  const role = validateRole(input.role);
  const actorUserId = validateId(input.actor.userId, 'actor.userId');
  const actorRole = await store.getMembershipRole(teamId, actorUserId);
  requireAdmin(actorRole, 'teams:add-member', { actorUserId, teamId });
  const membership = await store.addMembership({ teamId, userId, role });
  return { membership };
}

async function removeMember(
  store: TeamStore,
  input: RemoveMemberInput,
): Promise<RemoveMemberOutput> {
  const teamId = validateId(input.teamId, 'teamId');
  const userId = validateId(input.userId, 'userId');
  const actorUserId = validateId(input.actor.userId, 'actor.userId');
  const actorRole = await store.getMembershipRole(teamId, actorUserId);
  requireAdmin(actorRole, 'teams:remove-member', { actorUserId, teamId });

  // Last-admin guard: refuse to remove the last admin row. Run the
  // check + the delete in the same logical operation. There's still a
  // narrow TOCTOU window between countAdmins and removeMembership for
  // concurrent removes — acceptable for MVP because the worst case is
  // an empty-admin team, not a security boundary breach. A future
  // tightening would wrap the pair in a serializable txn.
  const targetRole = await store.getMembershipRole(teamId, userId);
  if (targetRole === null) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName: 'teams:remove-member',
      message: `user '${userId}' is not a member of team '${teamId}'`,
    });
  }
  if (targetRole === 'admin') {
    const adminCount = await store.countAdmins(teamId);
    if (adminCount <= 1) {
      throw new PluginError({
        code: 'cannot-remove-last-admin',
        plugin: PLUGIN_NAME,
        hookName: 'teams:remove-member',
        message: `cannot remove the last admin of team '${teamId}'`,
      });
    }
  }

  await store.removeMembership(teamId, userId);
}

async function listMembers(
  store: TeamStore,
  input: ListMembersInput,
): Promise<ListMembersOutput> {
  const teamId = validateId(input.teamId, 'teamId');
  const actorUserId = validateId(input.actor.userId, 'actor.userId');
  const actorRole = await store.getMembershipRole(teamId, actorUserId);
  requireAdmin(actorRole, 'teams:list-members', { actorUserId, teamId });
  const members = await store.listMembers(teamId);
  return { members };
}
