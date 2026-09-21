import { isOwnerlessId, PluginError, type AgentContext, type HookBus } from '@ax/core';

import { resolveOwnerUserId } from './owner.js';
import { PLUGIN_NAME } from './plugin-name.js';

export const AGENTS_RESOLVE_HOOK = 'agents:resolve';

export interface MemoryAccess {
  userId: string;
  visibility: 'personal' | 'team';
}

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
    { agent?: { id?: unknown; ownerId?: unknown; ownerType?: unknown; visibility?: unknown } } | null
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
  if (agent.visibility === 'personal' && agent.ownerId !== userId) {
    throw new PluginError({
      code: 'forbidden',
      plugin: PLUGIN_NAME,
      message: 'This personal memory belongs to another person',
    });
  }
  return { userId, visibility: agent.visibility as 'personal' | 'team' };
}

export function memoryReadScope(access: MemoryAccess): { ownerUserId?: string } {
  return access.visibility === 'team' ? {} : { ownerUserId: access.userId };
}
