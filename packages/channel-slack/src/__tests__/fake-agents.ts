import { PluginError, isOwnerlessId, type HookBus } from '@ax/core';

export interface FakeAgent {
  id: string;
  displayName: string;
  visibility: 'personal' | 'team';
  ownerType: 'user' | 'team';
  /** A user id for a personal agent (its creator), a team id for a team agent. */
  ownerId: string;
  /** When it was made. Default: one fixed instant shared by every agent. */
  createdAt?: Date;
  /**
   * A personal agent's audience (TASK-1246): `everyone` admits any person.
   * Default `just-me`, which `shareWith` turns into a list naming whoever it
   * names. Ignored on a team agent.
   */
  audience?: 'just-me' | 'everyone';
  /** A personal agent's other owners, beside its creator (TASK-1246). Ignored on a team agent. */
  coOwners?: string[];
}

type Role = 'admin' | 'member';

const PLUGIN = '@ax/agents';
const STAMP = new Date('2026-10-01T00:00:00.000Z');

/**
 * `agents:resolve`, `agents:can-set-shared-credential` and
 * `agents:list-for-user` answered the way @ax/agents answers them, over an
 * in-memory model of agents and team roles (packages/agents/src/plugin.ts
 * `resolveAgent`, `assertWriteAllowed`, `sharedCredentialSetAllowed`,
 * `listForUser`; acl.ts `checkAccess`; scope.ts `scopedAgents`):
 *
 *   resolve        missing → `not-found`; personal: its owners (its creator
 *                  and `coOwners`) and its audience (`everyone`: any non-empty
 *                  id that isn't an owner-less stand-in, where the real one
 *                  also asks auth that it is an AX account; a list: whoever
 *                  `shareWith` names); team: any member of the owning team;
 *                  anyone else → `forbidden`. The answer is the whole agent
 *                  record, as the real one returns it: `shared` (a team
 *                  agent, or a personal agent whose audience isn't
 *                  `just-me`), a personal agent's `audience`, and `isOwner`
 *                  for the user asked about (always false on a team agent).
 *   can-set-…      missing → `not-found`; `{ allowed: false }` for an actor
 *                  who can't write the agent (a workspace admin always can);
 *                  then true only for a TEAM agent and the actor's team role
 *                  `admin`. `actor.isAdmin` never grants it, and no personal
 *                  agent's owner ever gets it.
 *   list-for-user  the personal agents the user can use (as `resolve` admits
 *                  them) and every agent owned by a team in `teamIds`, newest
 *                  first, each with `isOwner` for the user. Like the real one
 *                  it takes `teamIds` on trust: the caller asks @ax/teams for
 *                  them (`teamsOf` is that answer).
 *
 * `workspaceAdminsMayManage` models a later agents rule that WOULD let a
 * workspace admin set a team agent's shared credential (as
 * agents:can-manage-connectors does): channel-slack must still refuse them,
 * because it always asks as a non-admin.
 *
 * `calls` records every input, `faults` makes a hook throw, `answers` makes
 * `agents:can-set-shared-credential` return that value as is (a malformed
 * answer, say) once the agent is known to exist.
 */
export function fakeAgents(bus: HookBus, o: { workspaceAdminsMayManage?: boolean } = {}) {
  const agents = new Map<string, FakeAgent>();
  const teams = new Map<string, Map<string, Role>>();
  const calls: Array<{ hook: string; input: Record<string, unknown> }> = [];
  const faults = new Map<string, unknown>();
  const answers = new Map<string, unknown>();

  /** A personal agent's list audience (TASK-1246): agent id → user ids it is shared with. */
  const sharedWith = new Map<string, Set<string>>();
  const isSharedWith = (agent: FakeAgent, userId: string): boolean => sharedWith.get(agent.id)?.has(userId) === true;

  /** A personal agent's whole audience, as the real one stores it: `everyone`, a list `shareWith` made, or `just-me`. */
  const audienceOf = (agent: FakeAgent): 'just-me' | 'everyone' | 'list' => {
    if (agent.audience === 'everyone') return 'everyone';
    return (sharedWith.get(agent.id)?.size ?? 0) > 0 ? 'list' : 'just-me';
  };
  /** Its creator or a co-owner (TASK-1246). Nobody owns a team agent. */
  const isOwnerOf = (agent: FakeAgent, userId: string): boolean =>
    agent.ownerType === 'user' && (agent.ownerId === userId || (agent.coOwners ?? []).includes(userId));
  /** Someone a personal agent's audience admits, owner or not. */
  const inAudience = (agent: FakeAgent, userId: string): boolean => {
    const audience = audienceOf(agent);
    if (audience === 'everyone') return userId !== '' && !isOwnerlessId(userId);
    return audience === 'list' && isSharedWith(agent, userId);
  };

  const roleOf = (teamId: string, userId: string): Role | undefined => teams.get(teamId)?.get(userId);
  const canSee = (agent: FakeAgent, userId: string): boolean =>
    agent.visibility === 'personal'
      ? agent.ownerType === 'user' && (isOwnerOf(agent, userId) || inAudience(agent, userId))
      : agent.ownerType === 'team' && roleOf(agent.ownerId, userId) !== undefined;
  const notFound = (hookName: string, agentId: string): PluginError =>
    new PluginError({ code: 'not-found', plugin: PLUGIN, hookName, message: `agent '${agentId}' not found` });
  const enter = (hook: string, input: unknown): void => {
    calls.push({ hook, input: JSON.parse(JSON.stringify(input)) as Record<string, unknown> });
    const fault = faults.get(hook);
    if (fault !== undefined) throw fault;
  };

  /**
   * The whole agent record, as @ax/agents returns it: `shared` always, a
   * personal agent's `audience`, and never `coOwners` (the real one's
   * returns schema has no such key).
   */
  const record = (agent: FakeAgent) => {
    const { audience: _audience, coOwners: _coOwners, ...rest } = agent;
    const personal = agent.visibility === 'personal';
    return {
      ...rest,
      ...(personal ? { audience: audienceOf(agent) } : {}),
      shared: !personal || audienceOf(agent) !== 'just-me',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'default-model',
      runner: 'claude-sdk',
      skillAttachments: [],
      connectorAttachments: [],
      connectorExclusions: [],
      createdAt: agent.createdAt ?? STAMP,
      updatedAt: STAMP,
    };
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
    return { agent: { ...record(agent), isOwner: isOwnerOf(agent, userId) } };
  });

  bus.registerService('agents:list-for-user', PLUGIN, async (_ctx, raw) => {
    enter('agents:list-for-user', raw);
    const { userId, teamIds = [] } = raw as { userId: string; teamIds?: string[] };
    // TASK-1246: a personal agent merely shared with the user is listed too, with `isOwner` false.
    const listed = [...agents.values()].filter((a) =>
      a.ownerType === 'user' ? isOwnerOf(a, userId) || inAudience(a, userId) : teamIds.includes(a.ownerId),
    );
    // Added in age order, so the newest is last.
    return {
      agents: listed.reverse().map((a) => ({ ...record(a), isOwner: isOwnerOf(a, userId) })),
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
    if (answers.has('agents:can-set-shared-credential')) return answers.get('agents:can-set-shared-credential');
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
    answers,
    addAgent(agent: FakeAgent): void {
      agents.set(agent.id, agent);
    },
    /**
     * Share a personal agent with `userId` (a list audience naming them):
     * `resolve` admits them, `list-for-user` lists it with `isOwner` false,
     * and both say it is `shared`, as a list audience is.
     */
    shareWith(agentId: string, userId: string): void {
      const audience = sharedWith.get(agentId) ?? new Set<string>();
      sharedWith.set(agentId, audience);
      audience.add(userId);
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
    /** The teams `userId` has a role on, as @ax/teams would list them. */
    teamsOf(userId: string): string[] {
      return [...teams].filter(([, members]) => members.has(userId)).map(([teamId]) => teamId);
    },
  };
}
