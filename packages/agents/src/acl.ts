import type { ChatContext, HookBus } from '@ax/core';
import type { Agent } from './types.js';

/**
 * Inline ACL gate for `agents:resolve` and friends. Single source of truth
 * for "can `userId` see/use `agent`?" — the admin endpoints DO NOT
 * re-implement this logic; they call the same hook impls that call
 * `checkAccess`.
 *
 * Three cases:
 *   1. `personal` + owner matches userId → allow.
 *   2. `team`     + user is a member of `agent.ownerId` → allow.
 *   3. anything else → forbidden.
 *
 * For case 2 we call `teams:is-member` via the bus. That hook may not be
 * registered (e.g. @ax/teams isn't loaded in the dev preset). We DO NOT
 * declare it in the plugin manifest's `calls` because @ax/core's
 * bootstrap `verifyCalls` enforces hard presence — declaring it would
 * make @ax/teams a hard dep and break personal-only deployments.
 *
 * Instead we bus.call inside a try/catch:
 *   - hook present + member=true  → allow
 *   - hook present + member=false → forbidden
 *   - hook missing                → forbidden + warn-once for ops visibility
 *
 * The warn-once is path-of-least-surprise: an operator who configured
 * team agents without loading @ax/teams gets ONE log line per process
 * lifetime, not one per resolve call.
 */
export type AclResult =
  | { allowed: true }
  | { allowed: false; reason: 'forbidden' };

const PLUGIN_NAME = '@ax/agents';

interface IsMemberInput {
  teamId: string;
  userId: string;
}
interface IsMemberOutput {
  member: boolean;
}

interface AclDeps {
  /**
   * Test seam — when undefined, defaults to a process-wide flag so we
   * warn at most once. Tests pass a fresh `{ warned: false }` per case
   * to assert log discipline.
   */
  warnState?: { warned: boolean };
}

const globalWarnState = { warned: false };

export async function checkAccess(
  agent: Agent,
  userId: string,
  bus: HookBus,
  ctx: ChatContext,
  deps: AclDeps = {},
): Promise<AclResult> {
  // Personal — direct ownership check, no bus call.
  if (agent.visibility === 'personal') {
    if (agent.ownerType === 'user' && agent.ownerId === userId) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'forbidden' };
  }

  // Team — defensive parity check. The DB CHECK constraint
  // (owner_type='team' AND visibility='team') should make this
  // impossible, but if the row was inserted bypassing the constraint
  // (e.g. raw SQL), refuse rather than fall through.
  if (agent.ownerType !== 'team') {
    return { allowed: false, reason: 'forbidden' };
  }

  const warnState = deps.warnState ?? globalWarnState;
  let result: IsMemberOutput;
  try {
    result = await bus.call<IsMemberInput, IsMemberOutput>(
      'teams:is-member',
      ctx,
      { teamId: agent.ownerId, userId },
    );
  } catch (err) {
    // Most common failure shape: PluginError 'no-service' from the bus
    // when @ax/teams isn't loaded. Any other shape (impl threw) falls
    // here too — treat as deny so a degraded teams plugin can't grant
    // access by accident.
    if (!warnState.warned) {
      warnState.warned = true;
      ctx.logger.warn('agents_acl_team_check_unavailable', {
        plugin: PLUGIN_NAME,
        hook: 'teams:is-member',
        agentId: agent.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    return { allowed: false, reason: 'forbidden' };
  }

  return result.member
    ? { allowed: true }
    : { allowed: false, reason: 'forbidden' };
}
