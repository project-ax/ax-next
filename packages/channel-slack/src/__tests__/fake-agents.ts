import { PluginError, type HookBus } from '@ax/core';

export interface FakeAgent {
  id: string;
  displayName: string;
  visibility: 'personal' | 'team';
  ownerType: 'user' | 'team';
  /** A user id for a personal agent, a team id for a team agent. */
  ownerId: string;
}

type Role = 'admin' | 'member';

const PLUGIN = '@ax/agents';
const STAMP = new Date('2026-10-01T00:00:00.000Z');

/**
 * `agents:resolve` and `agents:can-set-shared-credential` answered the way
 * @ax/agents answers them, over an in-memory model of agents and team roles
 * (packages/agents/src/plugin.ts `resolveAgent`, `assertWriteAllowed`,
 * `sharedCredentialSetAllowed`; acl.ts `checkAccess`):
 *
 *   resolve        missing → `not-found`; personal: only its owner; team: any
 *                  member of the owning team; anyone else → `forbidden`. The
 *                  answer is the whole agent record, as the real one returns.
 *   can-set-…      missing → `not-found`; `{ allowed: false }` for an actor
 *                  who can't write the agent (a workspace admin always can);
 *                  then true only for a TEAM agent and the actor's team role
 *                  `admin`. `actor.isAdmin` never grants it.
 *
 * `workspaceAdminsMayManage` models a later agents rule that WOULD let a
 * workspace admin set a team agent's shared credential (as
 * agents:can-manage-connectors does): channel-slack must still refuse them,
 * because it always asks as a non-admin.
 *
 * `calls` records every input, `faults` makes a hook throw.
 */
export function fakeAgents(bus: HookBus, o: { workspaceAdminsMayManage?: boolean } = {}) {
  const agents = new Map<string, FakeAgent>();
  const teams = new Map<string, Map<string, Role>>();
  const calls: Array<{ hook: string; input: Record<string, unknown> }> = [];
  const faults = new Map<string, unknown>();

  const roleOf = (teamId: string, userId: string): Role | undefined => teams.get(teamId)?.get(userId);
  const canSee = (agent: FakeAgent, userId: string): boolean =>
    agent.visibility === 'personal'
      ? agent.ownerType === 'user' && agent.ownerId === userId
      : agent.ownerType === 'team' && roleOf(agent.ownerId, userId) !== undefined;
  const notFound = (hookName: string, agentId: string): PluginError =>
    new PluginError({ code: 'not-found', plugin: PLUGIN, hookName, message: `agent '${agentId}' not found` });
  const enter = (hook: string, input: unknown): void => {
    calls.push({ hook, input: JSON.parse(JSON.stringify(input)) as Record<string, unknown> });
    const fault = faults.get(hook);
    if (fault !== undefined) throw fault;
  };

  bus.registerService('agents:resolve', PLUGIN, async (_ctx, raw) => {
    enter('agents:resolve', raw);
    const { agentId, userId } = raw as { agentId: string; userId: string };
    const agent = agents.get(agentId);
    if (agent === undefined) throw notFound('agents:resolve', agentId);
    if (!canSee(agent, userId)) {
      throw new PluginError({
        code: 'forbidden',
        plugin: PLUGIN,
        hookName: 'agents:resolve',
        message: `agent '${agentId}' not accessible to user '${userId}'`,
      });
    }
    return {
      agent: {
        ...agent,
        allowedTools: [],
        mcpConfigIds: [],
        model: 'default-model',
        runner: 'claude-sdk',
        skillAttachments: [],
        connectorAttachments: [],
        connectorExclusions: [],
        createdAt: STAMP,
        updatedAt: STAMP,
      },
    };
  });

  bus.registerService('agents:can-set-shared-credential', PLUGIN, async (_ctx, raw) => {
    enter('agents:can-set-shared-credential', raw);
    const { agentId, actor } = raw as { agentId: string; actor: { userId: string; isAdmin: boolean } };
    const agent = agents.get(agentId);
    if (agent === undefined) throw notFound('agents:can-set-shared-credential', agentId);
    // assertWriteAllowed: a workspace admin, a personal agent's owner, a team agent's member.
    const writes =
      actor.isAdmin ||
      (agent.visibility === 'personal'
        ? agent.ownerType === 'user' && agent.ownerId === actor.userId
        : roleOf(agent.ownerId, actor.userId) !== undefined);
    if (!writes) return { allowed: false };
    if (o.workspaceAdminsMayManage === true && actor.isAdmin) return { allowed: true };
    // sharedCredentialSetAllowed: a team agent and a team admin, whatever isAdmin says.
    return {
      allowed:
        agent.visibility === 'team' && agent.ownerType === 'team' && roleOf(agent.ownerId, actor.userId) === 'admin',
    };
  });

  return {
    agents,
    calls,
    faults,
    addAgent(agent: FakeAgent): void {
      agents.set(agent.id, agent);
    },
    /** Put `userId` on the team with `role`, or (null) take them off it. */
    setRole(teamId: string, userId: string, role: Role | null): void {
      const members = teams.get(teamId) ?? new Map<string, Role>();
      teams.set(teamId, members);
      if (role === null) members.delete(userId);
      else members.set(userId, role);
    },
    /** Every input one hook was called with, in order. */
    inputs(hook: string): Array<Record<string, unknown>> {
      return calls.filter((c) => c.hook === hook).map((c) => c.input);
    },
  };
}
