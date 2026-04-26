import { PluginError } from '@ax/core';
import type { TeamRole } from './types.js';

/**
 * Centralised authz helpers for @ax/teams.
 *
 * The team-scoped hooks (`add-member`, `remove-member`, `list-members`)
 * all gate on the same question: "is `actor.userId` a team-admin in
 * `teamId`?" Single helper keeps the answer uniform — and the test
 * coverage doesn't fragment.
 *
 * NOTE: this lives at the plugin layer, not the SQL layer. The store
 * helpers (`getMembershipRole`) feed it; the plugin module composes
 * `getMembershipRole` + `requireAdmin` into the hook handlers.
 */

const PLUGIN_NAME = '@ax/teams';

export function requireAdmin(
  role: TeamRole | null,
  hookName: string,
  details: { actorUserId: string; teamId: string },
): void {
  if (role === 'admin') return;
  throw new PluginError({
    code: 'forbidden',
    plugin: PLUGIN_NAME,
    hookName,
    message:
      role === 'member'
        ? `user '${details.actorUserId}' is a member of team '${details.teamId}' but not an admin`
        : `user '${details.actorUserId}' is not a member of team '${details.teamId}'`,
  });
}
