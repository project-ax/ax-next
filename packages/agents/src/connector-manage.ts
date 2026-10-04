import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import type { Actor, Agent } from './types.js';

/**
 * The actor's standing on a team, as far as connector management cares:
 * `admin` (a member whose team role is admin), `member` (any other member) or
 * `none` (not a member, or no teams plugin loaded — `no-service`). Every OTHER
 * lookup failure propagates so it surfaces as a 5xx rather than a quiet
 * denial.
 */
export async function teamConnectorRole(
  bus: HookBus,
  ctx: AgentContext,
  teamId: string,
  userId: string,
): Promise<'admin' | 'member' | 'none'> {
  try {
    const result = await bus.call<
      { teamId: string; userId: string },
      { member: boolean; role?: 'admin' | 'member' }
    >('teams:is-member', ctx, { teamId, userId });
    if (result.member !== true) return 'none';
    return result.role === 'admin' ? 'admin' : 'member';
  } catch (err) {
    if (err instanceof PluginError && err.code === 'no-service') return 'none';
    throw err;
  }
}

/**
 * TASK-765 / TASK-798 — may `actor` change which connectors `agent` reaches
 * (attach, detach, exclude a legacy-owned connector, sign in ON the agent)? On
 * a team agent that changes what every member's runs reach — and a sign-in on
 * it decides whose account they all act as — so it is a decision about the
 * whole team, not about the actor's own use of the agent:
 *
 *   - a workspace admin: always;
 *   - a personal agent: its owner;
 *   - a team agent: a member whose team role is `admin` (the agent's "owner":
 *     a team agent has no single owning person).
 *
 * Deliberately NOT part of `assertWriteAllowed`, whose "any team member may
 * write" semantics stay as they were for the agent's other fields — this is a
 * narrower question asked on top of it. Anything we can't prove is a refusal:
 * a missing teams plugin (`no-service`) and malformed ownership are `false`;
 * every OTHER lookup failure propagates so it surfaces as a 5xx rather than a
 * quiet denial.
 *
 * Lives in its own module so the boot-time legacy-default conversion
 * (legacy-default-conversion.ts) applies the SAME rule without importing
 * plugin.ts.
 */
export async function connectorsManageAllowed(
  agent: Agent,
  bus: HookBus,
  ctx: AgentContext,
  actor: Actor,
): Promise<boolean> {
  if (actor.isAdmin) return true;
  if (agent.visibility === 'personal') {
    return agent.ownerType === 'user' && agent.ownerId === actor.userId;
  }
  if (agent.ownerType !== 'team') return false;
  return (await teamConnectorRole(bus, ctx, agent.ownerId, actor.userId)) === 'admin';
}
