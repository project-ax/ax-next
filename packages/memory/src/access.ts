import { isOwnerlessId, PluginError, type AgentContext, type HookBus } from '@ax/core';

import { resolveOwnerUserId } from './owner.js';
import { PLUGIN_NAME } from './plugin-name.js';

export const AGENTS_RESOLVE_HOOK = 'agents:resolve';

/**
 * Whose memory one operation is in, as {@link resolveMemoryAccess} decided it
 * for this caller, on this call. Never cached: it is asked on every operation.
 */
export interface MemoryAccess {
  userId: string;
  /**
   * Who this agent's memory is shared with.
   *
   * - `'personal'`: its creator's alone, a "Just me" agent. Reads, retracts and
   *   the `/memory` export are scoped to `userId`, who is the creator.
   * - `'team'`: this agent's memory is shared with everyone who can use it: a
   *   team agent, or a personal agent shared beyond its owners (TASK-1248).
   *   Reads aren't scoped by owner, each person's own facts are filed under
   *   them, and an outsider's words are never kept (`audience.ts`).
   *
   * The name predates sharing: `'team'` means "shared", whoever owns the
   * agent. The same value goes on the wire (`memory:recall`'s and
   * `memory:recall-receipts`' `visibility`), where it reads the same way.
   */
  visibility: 'personal' | 'team';
  /**
   * The team that owns a team agent (`agents:resolve`'s `ownerId`), and only
   * there. Memory asks `teams:is-member` about it before it names a member
   * (TASK-1209, `member-names.ts`). Never set on a shared personal agent,
   * whose `ownerId` is its creator, not a team.
   */
  teamId?: string;
  /**
   * The agent's own display name (`agents:resolve`'s `displayName`), on an
   * agent whose memory is shared (`visibility: 'team'`), and only there. A
   * person's name that reads as it is refused, so nobody can pass for the
   * agent (TASK-1213, `member-names.ts`). Absent when the answer carries none.
   */
  agentName?: string;
  /**
   * How to prove someone can use this agent before naming them in its memory:
   * `'agent'` means ask `agents:resolve` about them (TASK-1248). Set on a
   * shared personal agent's access, and only there, which never has a
   * `teamId`. A team agent's access has none: its members are proven by
   * `teams:is-member` on `teamId`.
   */
  memberCheck?: 'agent';
}

/**
 * Resolve whose memory this operation is in, from `agents:resolve`, on every
 * call. In this order, which is what makes it fail closed:
 *
 * 1. `ctx.agentId` must name an owned agent, and `agents:resolve` must admit
 *    `ctx.userId` to it. A refusal from it is passed on as it is.
 * 2. The answer must be about this agent, with a non-empty `ownerId`, and be
 *    `personal` + `user` or `team` + `team`. Anything else is `invalid-return`.
 * 3. A team agent: shared, its access unchanged since TASK-1209.
 * 4. A personal agent whose answer says exactly `shared: true` (TASK-1248):
 *    shared, like a team agent's, with `memberCheck: 'agent'` and no
 *    `teamId`. `agents:resolve` already admitted `userId`, which is the one
 *    "can use it" rule. `audience` is never read (card A's rule).
 * 5. Any other personal agent is Just me: its creator's alone. That includes a
 *    `shared` that is missing or isn't exactly `true`, and a co-owner of a
 *    Just-me agent (TASK-1248's decision: its `/memory` export is one file per
 *    agent, so owners can't keep private slices of it).
 */
export async function resolveMemoryAccess(
  bus: HookBus,
  ctx: AgentContext,
): Promise<MemoryAccess> {
  const userId = resolveOwnerUserId(ctx);
  if (
    typeof ctx.agentId !== 'string' ||
    ctx.agentId.trim() === '' ||
    isOwnerlessId(ctx.agentId)
  ) {
    throw new PluginError({
      code: 'forbidden',
      plugin: PLUGIN_NAME,
      message: 'Memory requires an owned agent',
    });
  }
  const out = await bus.call<
    { agentId: string; userId: string },
    {
      agent?: {
        id?: unknown;
        ownerId?: unknown;
        ownerType?: unknown;
        visibility?: unknown;
        displayName?: unknown;
        shared?: unknown;
      };
    } | null
  >(AGENTS_RESOLVE_HOOK, ctx, { agentId: ctx.agentId, userId });
  const agent = out?.agent;
  if (
    agent == null ||
    agent.id !== ctx.agentId ||
    typeof agent.ownerId !== 'string' ||
    agent.ownerId.trim() === '' ||
    !(
      (agent.visibility === 'personal' && agent.ownerType === 'user') ||
      (agent.visibility === 'team' && agent.ownerType === 'team')
    )
  ) {
    throw new PluginError({
      code: 'invalid-return',
      plugin: PLUGIN_NAME,
      hookName: AGENTS_RESOLVE_HOOK,
      message: 'Agent resolution returned unreadable memory ownership',
    });
  }
  const agentName = typeof agent.displayName === 'string' ? { agentName: agent.displayName } : {};
  if (agent.visibility === 'team') {
    return { userId, visibility: 'team', teamId: agent.ownerId, ...agentName };
  }
  if (agent.visibility === 'personal' && agent.shared === true) {
    return { userId, visibility: 'team', memberCheck: 'agent', ...agentName };
  }
  if (agent.ownerId !== userId) {
    throw new PluginError({
      code: 'forbidden',
      plugin: PLUGIN_NAME,
      message: 'This personal memory belongs to another person',
    });
  }
  return { userId, visibility: 'personal' };
}

/**
 * The owner scope a read, a retract or the export scan carries: the caller's
 * own rows on a Just-me agent, and none where the agent's memory is shared.
 */
export function memoryReadScope(access: MemoryAccess): { ownerUserId?: string } {
  return access.visibility === 'team' ? {} : { ownerUserId: access.userId };
}
