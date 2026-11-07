import { PluginError, type AgentContext, type HookBus } from '@ax/core';

/**
 * Who the caller is to an artifact (§6.6). `owner`: a member of the artifact's
 * agent (its person, or anyone on its team, D7). `link`: holds the artifact's
 * current share code. `none`: anyone else.
 */
export type ArtifactRole = 'owner' | 'link' | 'none';

export type ArtifactAction =
  | 'list'
  | 'view-any-version'
  | 'view-current'
  | 'download'
  | 'copy-link'
  | 'restore'
  | 'rename'
  | 'set-link'
  | 'delete';

/** Membership wins over a code: a member holding a link is still a member. */
export function roleFor(i: { agentMember: boolean; codeMatched: boolean }): ArtifactRole {
  if (i.agentMember) return 'owner';
  if (i.codeMatched) return 'link';
  return 'none';
}

/** The single access rule. A link holder sees the current version and nothing else. */
export function can(role: ArtifactRole, action: ArtifactAction): boolean {
  switch (role) {
    case 'owner':
      return true;
    case 'link':
      return action === 'view-current' || action === 'download';
    case 'none':
      return false;
  }
}

/**
 * Can ctx.userId reach `agentId`? `agents:resolve` is the agent ACL: it answers
 * not-found or forbidden for an agent that is missing, someone else's, or a
 * team the caller is not on, and all of those are `false`. Any other failure is
 * an outage, not an answer, and propagates as itself.
 */
export async function isAgentMember(bus: HookBus, ctx: AgentContext, agentId: string): Promise<boolean> {
  try {
    await bus.call<{ agentId: string; userId: string }, unknown>('agents:resolve', ctx, {
      agentId,
      userId: ctx.userId,
    });
    return true;
  } catch (err) {
    if (err instanceof PluginError && (err.code === 'not-found' || err.code === 'forbidden')) return false;
    throw err;
  }
}
